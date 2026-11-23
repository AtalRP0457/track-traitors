// Renders each track's pre-made images from its JSON:
//   <id>.bg.svg       full-size themed background — host + phone "My screen" view
//   <id>.minimap.svg  small road outline for the corner minimap and the phone's trap draft
// Run after editing a track file:  npm run tracks
//
// All art is drawn here from code (no image files): ours, see ASSETS.md.
// Open sea is left partly see-through: the host draws moving waves underneath it.
// No text in the art, so Mirror versions can simply flip the image.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTrack, type Theme, type Vec } from "../shared/track-format";
import { buildTrack, inPoly, pointAt, roadHalf, type Track } from "../game/track";

const DIR = join(import.meta.dirname, "..", "public", "assets", "tracks");

const f = (n: number) => Math.round(n * 10) / 10;
const poly = (pts: Vec[]) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;

/** Small seeded random generator so the art is the same every time it's rebuilt. */
function rng(seed: string) {
  let h = 1779033703;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

// ---------- theme look ----------

interface Look {
  sea: [string, string]; // deep → lighter
  seaOpacity: number;
  shallow: string;
  foam: string;
  beach: string;
  wetSand: string;
  land: string;
  landDark: string;
  /** Land reaches this far from the road edge (px); the rest is sea. */
  margin: number;
  /** Fill the inside of the loop with land too. */
  fillInside: boolean;
  road: string;
  roadEdge: string;
  curbs: [string, string] | null;
  centerDots: boolean;
}

const LOOKS: Record<Theme, Look> = {
  beach: { sea: ["#0a5f99", "#1a8fd0"], seaOpacity: 0.82, shallow: "#4fd2e0", foam: "#ffffff", beach: "#f5e3b5", wetSand: "#e2c98f", land: "#49b765", landDark: "#2f9a52", margin: 120, fillInside: true, road: "#4a4f5c", roadEdge: "#f5e3b5", curbs: ["#e8453c", "#ffffff"], centerDots: true },
  harbor: { sea: ["#08507f", "#1580bd"], seaOpacity: 0.82, shallow: "#3fc0d6", foam: "#ffffff", beach: "#efd9a6", wetSand: "#d6bb80", land: "#57b84f", landDark: "#3b9a3f", margin: 150, fillInside: true, road: "#454a55", roadEdge: "#efd9a6", curbs: null, centerDots: true },
  lagoon: { sea: ["#07628f", "#1aa0c9"], seaOpacity: 0.8, shallow: "#56dbd6", foam: "#ffffff", beach: "#f2e2b8", wetSand: "#dcc58e", land: "#45b46a", landDark: "#2b9454", margin: 95, fillInside: false, road: "#4a4f5c", roadEdge: "#f2e2b8", curbs: ["#2b8fd6", "#ffffff"], centerDots: true },
  jungle: { sea: ["#0a5679", "#16839f"], seaOpacity: 0.82, shallow: "#3cc0b5", foam: "#e9fff8", beach: "#d9c28a", wetSand: "#bfa66d", land: "#2f8a3c", landDark: "#1f6a2c", margin: 330, fillInside: true, road: "#9a6a3e", roadEdge: "#6e4a28", curbs: null, centerDots: false },
  volcano: { sea: ["#0b3550", "#164f70"], seaOpacity: 0.85, shallow: "#2b6f80", foam: "#c9d6dd", beach: "#5d5450", wetSand: "#4a4240", land: "#4b403d", landDark: "#3a312f", margin: 300, fillInside: true, road: "#2c2628", roadEdge: "#ff7a1a", curbs: null, centerDots: false },
  night: { sea: ["#050d24", "#0c1f45"], seaOpacity: 0.85, shallow: "#16365e", foam: "#5b77a8", beach: "#3c3548", wetSand: "#2f2a3a", land: "#2a2638", landDark: "#1f1c2b", margin: 150, fillInside: true, road: "#7a5233", roadEdge: "#3a2616", curbs: null, centerDots: false },
  sandcastle: { sea: ["#0b67a3", "#22a2dc"], seaOpacity: 0.8, shallow: "#5adbe6", foam: "#ffffff", beach: "#f7e6ba", wetSand: "#e4cb92", land: "#f7e6ba", landDark: "#efd8a0", margin: 150, fillInside: true, road: "#5a5f6c", roadEdge: "#c99a55", curbs: null, centerDots: true },
};

// ---------- geometry helpers ----------

function loopPath(t: Track): string {
  let d = `M${f(t.xs[0])} ${f(t.ys[0])}`;
  for (let i = 1; i < t.xs.length; i++) d += `L${f(t.xs[i])} ${f(t.ys[i])}`;
  return d + "Z";
}

function pathAlong(t: Track, s0: number, s1: number, step = 4): string {
  let d = "";
  for (let s = s0; s <= s1; s += step) {
    const p = pointAt(t, s);
    d += `${d ? "L" : "M"}${f(p.x)} ${f(p.y)}`;
  }
  return d;
}

/** Distance from a point to the road's centerline (dense samples). */
function roadDist(t: Track, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < t.xs.length; i += 2) {
    const d = (t.xs[i] - x) ** 2 + (t.ys[i] - y) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const loopPoly = (t: Track): Vec[] => Array.from({ length: Math.floor(t.xs.length / 4) }, (_, i) => [t.xs[i * 4], t.ys[i * 4]] as Vec);

/** Water channel rectangles under each bridge, out to the sea. */
function channels(t: Track): Vec[][] {
  const { w, h } = t.def.world;
  return t.bridges.map((b) => {
    const mid = pointAt(t, (b.s0 + b.s1) / 2);
    const len = b.s1 - b.s0;
    const nx = -Math.sin(mid.a), ny = Math.cos(mid.a);
    const reach = Math.max(w, h);
    const half = len / 2 - 6;
    const ax = Math.cos(mid.a) * half, ay = Math.sin(mid.a) * half;
    return [[mid.x - ax - nx * reach, mid.y - ay - ny * reach], [mid.x + ax - nx * reach, mid.y + ay - ny * reach], [mid.x + ax + nx * reach, mid.y + ay + ny * reach], [mid.x - ax + nx * reach, mid.y - ay + ny * reach]];
  });
}

// ---------- the scene ----------

class Art {
  defs: string[] = [];
  under: string[] = [];
  land: string[] = [];
  road: string[] = [];
  over: string[] = [];
  top: string[] = [];
  rand: () => number;
  look: Look;
  inside: Vec[];
  chans: Vec[][];
  taken: { x: number; y: number; r: number }[] = [];

  constructor(public t: Track, public theme: Theme) {
    this.rand = rng(t.def.id);
    this.look = LOOKS[theme];
    this.inside = loopPoly(t);
    this.chans = channels(t);
  }

  r(a: number, b: number) {
    return a + this.rand() * (b - a);
  }
  pick<T>(xs: T[]): T {
    return xs[Math.floor(this.rand() * xs.length)];
  }

  /** Is this point land (not sea, not a channel)? */
  isLand(x: number, y: number, pad = 0): boolean {
    if (this.chans.some((c) => inPoly(c, x, y))) return false;
    const d = roadDist(this.t, x, y);
    if (d < this.t.def.width / 2 + this.look.margin - pad) return true;
    return this.look.fillInside && inPoly(this.inside, x, y) && d > 0;
  }

  /** Find a free spot: on land (or sea), clear of the road by `clear` px, not overlapping other things. */
  spot(r: number, opts: { sea?: boolean; clear?: number; near?: number; tries?: number } = {}): { x: number; y: number } | null {
    const { w, h } = this.t.def.world;
    const clear = opts.clear ?? 18;
    for (let k = 0; k < (opts.tries ?? 60); k++) {
      const x = this.r(r, w - r), y = this.r(r, h - r);
      const d = roadDist(this.t, x, y);
      const edge = this.t.def.width / 2 + clear + r;
      if (d < edge) continue;
      if (opts.near !== undefined && d > edge + opts.near) continue;
      if (opts.sea ? this.isLand(x, y, -40 - r) : !this.isLand(x, y, r + 10)) continue;
      if (this.t.shortcuts.some((sc) => { for (let i = 0; i < sc.path.xs.length; i += 3) if (Math.hypot(sc.path.xs[i] - x, sc.path.ys[i] - y) < sc.half + r + 30) return true; return false; })) continue;
      if (this.taken.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + r)) continue;
      this.taken.push({ x, y, r });
      return { x, y };
    }
    return null;
  }

  many(n: number, r: [number, number], draw: (x: number, y: number, r: number) => void, opts: { sea?: boolean; clear?: number; near?: number } = {}) {
    for (let i = 0; i < n; i++) {
      const rr = this.r(r[0], r[1]);
      const p = this.spot(rr, opts);
      if (p) draw(p.x, p.y, rr);
    }
  }

  // ---------- layers ----------

  sea() {
    const { w, h } = this.t.def.world;
    const L = this.look;
    this.defs.push(
      `<radialGradient id="sea" cx="50%" cy="50%" r="75%"><stop offset="0" stop-color="${L.sea[1]}"/><stop offset="1" stop-color="${L.sea[0]}"/></radialGradient>`,
      // Little curved wave marks and sparkles, tiled.
      `<pattern id="waves" width="180" height="120" patternUnits="userSpaceOnUse">` +
        `<path d="M10 30q15-10 30 0t30 0" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="3" stroke-linecap="round"/>` +
        `<path d="M100 85q12-8 24 0t24 0" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="2.5" stroke-linecap="round"/>` +
        `<path d="M60 105q10-6 20 0" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2" stroke-linecap="round"/>` +
        `<circle cx="150" cy="25" r="2" fill="#ffffff" fill-opacity="0.35"/><circle cx="35" cy="75" r="1.5" fill="#ffffff" fill-opacity="0.3"/>` +
        `</pattern>`,
      `<pattern id="ripples" width="60" height="40" patternUnits="userSpaceOnUse">` +
        `<path d="M5 12q8-5 16 0t16 0" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2" stroke-linecap="round"/>` +
        `<path d="M30 32q6-4 12 0" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="1.6" stroke-linecap="round"/>` +
        `</pattern>`,
    );
    this.under.push(`<rect width="${w}" height="${h}" fill="url(#sea)" opacity="${L.seaOpacity}"/>`, `<rect width="${w}" height="${h}" fill="url(#waves)"/>`);
  }

  /** Island: rings of foam → shallows → wet sand → beach → land around the road (+ inside the loop). */
  island() {
    const t = this.t, L = this.look;
    const road = loopPath(t);
    // A few bulges so the coast isn't a perfect offset of the road.
    const bulges: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < 9; i++) {
      const p = pointAt(t, this.r(0, t.length));
      const side = this.rand() < 0.5 ? -1 : 1;
      const out = t.def.width / 2 + L.margin * this.r(0.5, 0.9);
      const x = p.x - Math.sin(p.a) * out * side, y = p.y + Math.cos(p.a) * out * side;
      if (x > 80 && y > 80 && x < t.def.world.w - 80 && y < t.def.world.h - 80) bulges.push({ x, y, r: this.r(70, 140) });
    }
    const ring = (grow: number, color: string, opacity = 1) => {
      const wdt = t.def.width + 2 * (L.margin + grow);
      if (wdt <= 0) return;
      let g = `<g fill="${color}" stroke="${color}" opacity="${opacity}">`;
      g += `<path d="${road}" fill="none" stroke-width="${f(wdt)}" stroke-linejoin="round"/>`;
      if (L.fillInside) g += `<path d="${road}" stroke="none"/>`;
      if (grow >= 0) for (const b of bulges) g += `<circle cx="${f(b.x)}" cy="${f(b.y)}" r="${f(Math.max(1, b.r + grow))}" stroke="none"/>`;
      this.land.push(g + "</g>");
    };
    ring(46, L.foam, 0.45);
    ring(30, L.shallow, 0.85);
    this.land.push(`<g opacity="0.9">`);
    ring(30, "url(#ripples)");
    this.land.push(`</g>`);
    ring(10, L.wetSand);
    ring(0, L.beach);
    ring(-60, L.land);
  }

  /** Cut the bridge channels through the island (Coconut Harbor). */
  channelsCut() {
    for (const c of this.chans) {
      this.land.push(`<path d="${poly(c)}" fill="${this.look.shallow}"/>`, `<path d="${poly(c)}" fill="url(#ripples)"/>`);
    }
  }

  /** The road: edge, optional curbs, surface, bridges, surfaces on top, center dots, start line. */
  roadway() {
    const t = this.t, L = this.look, w = t.def.width;
    const road = loopPath(t);
    this.road.push(`<path d="${road}" fill="none" stroke="#000000" stroke-opacity="0.18" stroke-width="${w + 34}" stroke-linejoin="round"/>`);
    this.road.push(`<path d="${road}" fill="none" stroke="${L.roadEdge}" stroke-width="${w + 22}" stroke-linejoin="round"/>`);
    if (L.curbs) {
      this.road.push(
        `<path d="${road}" fill="none" stroke="${L.curbs[1]}" stroke-width="${w + 14}" stroke-linejoin="round"/>`,
        `<path d="${road}" fill="none" stroke="${L.curbs[0]}" stroke-width="${w + 14}" stroke-linejoin="round" stroke-dasharray="18 18"/>`,
      );
    }
    this.road.push(`<path d="${road}" fill="none" stroke="${L.road}" stroke-width="${w}" stroke-linejoin="round"/>`);
  }

  bridges() {
    const t = this.t, L = this.look;
    for (const b of t.bridges) {
      const d = pathAlong(t, b.s0, b.s1);
      this.road.push(
        `<path d="${d}" fill="none" stroke="${L.shallow}" stroke-width="${t.def.width + 26}"/>`,
        `<path d="${d}" fill="none" stroke="url(#ripples)" stroke-width="${t.def.width + 26}"/>`,
        // Shadow, posts, rails, planks.
        `<path d="${d}" fill="none" stroke="#000000" stroke-opacity="0.25" stroke-width="${b.half * 2 + 22}" transform="translate(6 8)"/>`,
        `<path d="${d}" fill="none" stroke="#5a3a1e" stroke-width="${b.half * 2 + 14}"/>`,
        `<path d="${d}" fill="none" stroke="#3b2412" stroke-width="${b.half * 2 + 18}" stroke-dasharray="8 52"/>`,
        `<path d="${d}" fill="none" stroke="#b07a43" stroke-width="${b.half * 2}"/>`,
        `<path d="${d}" fill="none" stroke="#7a5230" stroke-width="${b.half * 2}" stroke-dasharray="2.5 11"/>`,
      );
    }
  }

  surfaces() {
    const t = this.t;
    this.defs.push(
      `<pattern id="ash" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="5" cy="6" r="2" fill="#5d5955"/><circle cx="16" cy="15" r="2.5" fill="#b4afa8"/><circle cx="20" cy="4" r="1.5" fill="#6b6661"/><circle cx="8" cy="19" r="1.5" fill="#c8c3bb"/></pattern>`,
    );
    for (const s of t.def.surfaces) {
      if (s.kind === "sand") this.road.push(`<path d="${poly(s.poly)}" fill="${this.look.beach}"/>`);
      if (s.kind === "water") {
        // Shallow water over the road: clearly water (it slows cars, so it must be seen).
        this.road.push(
          `<path d="${poly(s.poly)}" fill="${this.look.foam}" fill-opacity="0.5" transform="translate(0 0)" stroke="${this.look.foam}" stroke-opacity="0.6" stroke-width="10" stroke-linejoin="round"/>`,
          `<path d="${poly(s.poly)}" fill="${this.look.shallow}" fill-opacity="0.92"/>`,
          `<path d="${poly(s.poly)}" fill="url(#ripples)"/>`,
        );
      }
      if (s.kind === "ash") {
        // Clip ash to the road so it reads as a patch on it.
        const id = `ashclip${this.defs.length}`;
        this.defs.push(`<clipPath id="${id}"><path d="${loopPath(t)}" fill="none" stroke="#000" stroke-width="${t.def.width + 24}"/></clipPath>`);
        this.road.push(`<g clip-path="url(#${id})"><path d="${poly(s.poly)}" fill="#8f8a84"/><path d="${poly(s.poly)}" fill="url(#ash)"/></g>`);
      }
    }
  }

  centerAndStart() {
    const t = this.t;
    if (this.look.centerDots) {
      let dots = "";
      for (let i = 0; i < t.xs.length; i += 6) dots += `<circle cx="${f(t.xs[i])}" cy="${f(t.ys[i])}" r="2.5"/>`;
      this.road.push(`<g fill="#ffffff" fill-opacity="0.35">${dots}</g>`);
    }
    const s = pointAt(t, 0);
    const sq = 10;
    const cells = Math.floor(t.def.width / sq);
    let checks = "";
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < 2; j++) checks += `<rect x="${f((j - 1) * sq)}" y="${f((i - cells / 2) * sq)}" width="${sq}" height="${sq}" fill="${(i + j) % 2 ? "#111111" : "#ffffff"}"/>`;
    }
    this.over.push(`<g transform="translate(${f(s.x)} ${f(s.y)}) rotate(${f((s.a * 180) / Math.PI)})">${checks}</g>`);
  }

  // ---------- props (all seen from above) ----------

  shadow(x: number, y: number, r: number, dx = 8, dy = 10) {
    return `<ellipse cx="${f(x + dx)}" cy="${f(y + dy)}" rx="${f(r)}" ry="${f(r * 0.85)}" fill="#000000" fill-opacity="0.22"/>`;
  }

  palm(x: number, y: number, r: number, coconuts = true) {
    const rot = this.r(0, 360);
    const greens = ["#2f9e44", "#38b24d", "#279039"];
    let g = this.shadow(x, y, r * 0.8, r * 0.35, r * 0.45);
    g += `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)})">`;
    const n = 7;
    for (let k = 0; k < n; k++) {
      const a = (360 / n) * k + this.r(-10, 10);
      const len = r * this.r(0.85, 1.05);
      g += `<g transform="rotate(${f(a)})"><path d="M0 0Q${f(len * 0.5)} ${f(-r * 0.32)} ${f(len)} 0Q${f(len * 0.5)} ${f(r * 0.32)} 0 0Z" fill="${this.pick(greens)}"/>` +
        `<path d="M2 0L${f(len * 0.95)} 0" stroke="#1d6e2c" stroke-width="1.6"/></g>`;
    }
    if (coconuts) for (let k = 0; k < 3; k++) g += `<circle cx="${f(Math.cos(k * 2.1) * r * 0.16)}" cy="${f(Math.sin(k * 2.1) * r * 0.16)}" r="${f(r * 0.13)}" fill="#6b4423" stroke="#3f2612" stroke-width="1.2"/>`;
    g += `<circle r="${f(r * 0.1)}" fill="#8a5a2b"/></g>`;
    this.top.push(g);
  }

  bush(x: number, y: number, r: number, colors = ["#2f9e44", "#3fb556", "#268a3a"]) {
    let g = this.shadow(x, y, r, 5, 6);
    for (let k = 0; k < 4; k++) {
      const a = this.r(0, Math.PI * 2), d = this.r(0, r * 0.5);
      g += `<circle cx="${f(x + Math.cos(a) * d)}" cy="${f(y + Math.sin(a) * d)}" r="${f(r * this.r(0.5, 0.75))}" fill="${this.pick(colors)}"/>`;
    }
    g += `<circle cx="${f(x - r * 0.25)}" cy="${f(y - r * 0.3)}" r="${f(r * 0.22)}" fill="#ffffff" fill-opacity="0.12"/>`;
    this.land.push(g);
  }

  flowers(x: number, y: number, r: number) {
    let g = "";
    const c = this.pick(["#ff5d8f", "#ffd23f", "#ffffff", "#ff8a3d", "#c77dff"]);
    for (let k = 0; k < 6; k++) g += `<circle cx="${f(x + this.r(-r, r))}" cy="${f(y + this.r(-r, r))}" r="${f(this.r(2.5, 4.5))}" fill="${c}"/>`;
    this.land.push(g);
  }

  rock(x: number, y: number, r: number, base = "#8b8f96", light = "#b7bcc4") {
    const pts: Vec[] = [];
    const n = 7;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const rr = r * this.r(0.7, 1.05);
      pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85]);
    }
    this.land.push(
      `<path d="${poly(pts.map(([px, py]) => [px + 5, py + 6]))}" fill="#000000" fill-opacity="0.25"/>`,
      `<path d="${poly(pts)}" fill="${base}"/>`,
      `<path d="${poly(pts.map(([px, py]) => [x + (px - x) * 0.55 - r * 0.15, y + (py - y) * 0.55 - r * 0.18]))}" fill="${light}" fill-opacity="0.7"/>`,
    );
  }

  seaRock(x: number, y: number, r: number) {
    this.land.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r + 8)}" fill="${this.look.foam}" fill-opacity="0.35"/>`);
    this.rock(x, y, r);
  }

  umbrella(x: number, y: number, r: number) {
    const cols = this.pick([["#ff4d6d", "#ffffff"], ["#ffd23f", "#2b8fd6"], ["#3ddc84", "#ffffff"], ["#ff8a3d", "#ffe9a8"]]);
    const towelA = this.r(0, 360);
    let g = `<g transform="translate(${f(x)} ${f(y)})">`;
    g += `<rect x="${f(r * 0.4)}" y="${f(-r * 0.35)}" width="${f(r * 1.3)}" height="${f(r * 0.7)}" rx="3" fill="${this.pick(["#4da3ff", "#ff8fd1", "#b57bff", "#ffd23f"])}" transform="rotate(${f(towelA)})"/>`;
    g += `<ellipse cx="7" cy="9" rx="${f(r)}" ry="${f(r * 0.85)}" fill="#000000" fill-opacity="0.2"/>`;
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      g += `<path d="M0 0L${f(Math.cos(a0) * r)} ${f(Math.sin(a0) * r)}L${f(Math.cos(a1) * r)} ${f(Math.sin(a1) * r)}Z" fill="${cols[k % 2]}"/>`;
    }
    g += `<circle r="3" fill="#333"/></g>`;
    this.top.push(g);
  }

  ball(x: number, y: number) {
    this.top.push(
      `<g transform="translate(${f(x)} ${f(y)})"><circle r="9" fill="#ffffff"/><path d="M0 -9A9 9 0 0 1 9 0L0 0Z" fill="#ff4d6d"/><path d="M0 9A9 9 0 0 1 -9 0L0 0Z" fill="#4da3ff"/><path d="M9 0A9 9 0 0 1 0 9L0 0Z" fill="#ffd23f"/></g>`,
    );
  }

  surfboard(x: number, y: number) {
    const c = this.pick(["#ff4d6d", "#2ee6d6", "#ffd23f", "#b57bff"]);
    this.top.push(`<g transform="translate(${f(x)} ${f(y)}) rotate(${f(this.r(0, 180))})"><ellipse rx="34" ry="9" fill="${c}"/><path d="M-30 0L30 0" stroke="#ffffff" stroke-width="2"/></g>`);
  }

  boat(x: number, y: number, r: number, sail = true) {
    const a = this.r(0, 360);
    const hull = this.pick(["#ffffff", "#ffe9a8", "#ff8a3d", "#4da3ff"]);
    let g = `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(a)})">`;
    g += `<path d="M${f(-r * 1.6)} 0Q${f(-r * 1.2)} ${f(r * 0.9)} 0 ${f(r * 0.65)}L${f(r * 1.2)} 0L0 ${f(-r * 0.65)}Q${f(-r * 1.2)} ${f(-r * 0.9)} ${f(-r * 1.6)} 0Z" fill="#ffffff" fill-opacity="0.35" transform="translate(${f(-r * 0.6)} 0) scale(1.25 1.4)"/>`; // wake
    g += `<path d="M${f(-r * 1.2)} ${f(-r * 0.5)}L${f(r * 0.6)} ${f(-r * 0.5)}Q${f(r * 1.3)} 0 ${f(r * 0.6)} ${f(r * 0.5)}L${f(-r * 1.2)} ${f(r * 0.5)}Z" fill="${hull}" stroke="#2a3a4a" stroke-width="2"/>`;
    g += `<rect x="${f(-r * 0.9)}" y="${f(-r * 0.3)}" width="${f(r * 1.1)}" height="${f(r * 0.6)}" fill="#8a5a2b"/>`;
    if (sail) g += `<path d="M${f(-r * 0.2)} ${f(-r * 0.05)}L${f(r * 0.3)} ${f(-r * 1.3)}L${f(-r * 0.6)} ${f(-r * 0.05)}Z" fill="#ffffff" stroke="#c9d6dd" stroke-width="1.5"/>`;
    this.land.push(g + "</g>");
  }

  crate(x: number, y: number, r: number) {
    const a = this.r(0, 90);
    this.top.push(
      `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(a)})"><rect x="${f(-r + 4)}" y="${f(-r + 5)}" width="${f(r * 2)}" height="${f(r * 2)}" fill="#000" fill-opacity="0.25"/>` +
        `<rect x="${f(-r)}" y="${f(-r)}" width="${f(r * 2)}" height="${f(r * 2)}" fill="#b5834d" stroke="#6e4a28" stroke-width="3"/>` +
        `<path d="M${f(-r)} ${f(-r)}L${f(r)} ${f(r)}M${f(r)} ${f(-r)}L${f(-r)} ${f(r)}" stroke="#6e4a28" stroke-width="3"/></g>`,
    );
  }

  barrel(x: number, y: number, r: number) {
    this.top.push(
      `<circle cx="${f(x + 4)}" cy="${f(y + 5)}" r="${f(r)}" fill="#000" fill-opacity="0.25"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="#9a5b2e" stroke="#4a2a12" stroke-width="3"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.55)}" fill="none" stroke="#4a2a12" stroke-width="2"/>`,
    );
  }

  /** Wooden pier from a shore point out to sea along angle a. */
  pier(x: number, y: number, a: number, len: number) {
    const w = 34;
    let g = `<g transform="translate(${f(x)} ${f(y)}) rotate(${f((a * 180) / Math.PI)})">`;
    g += `<rect x="0" y="${-w / 2 + 6}" width="${len}" height="${w}" fill="#000" fill-opacity="0.25"/>`;
    for (let k = 0; k <= len; k += 40) g += `<circle cx="${k}" cy="${-w / 2 - 3}" r="5" fill="#4a2a12"/><circle cx="${k}" cy="${w / 2 + 3}" r="5" fill="#4a2a12"/>`;
    g += `<rect x="0" y="${-w / 2}" width="${len}" height="${w}" fill="#b07a43"/>`;
    for (let k = 6; k < len; k += 9) g += `<rect x="${k}" y="${-w / 2}" width="2" height="${w}" fill="#7a5230"/>`;
    this.land.push(g + "</g>");
  }

  lily(x: number, y: number, r: number) {
    const a = this.r(0, 360);
    let g = `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(a)})"><path d="M0 0L${f(r)} ${f(-r * 0.25)}A${f(r)} ${f(r)} 0 1 1 ${f(r)} ${f(r * 0.25)}Z" fill="#3fae4f" stroke="#2b8a3c" stroke-width="1.5"/>`;
    if (this.rand() < 0.4) g += `<circle cx="${f(-r * 0.3)}" cy="0" r="${f(r * 0.3)}" fill="#ff8fd1"/><circle cx="${f(-r * 0.3)}" cy="0" r="${f(r * 0.12)}" fill="#ffd23f"/>`;
    this.land.push(g + "</g>");
  }

  reeds(x: number, y: number) {
    let g = "";
    for (let k = 0; k < 7; k++) {
      const a = this.r(-0.6, 0.6) - Math.PI / 2, l = this.r(14, 24);
      g += `<path d="M${f(x)} ${f(y)}L${f(x + Math.cos(a) * l)} ${f(y + Math.sin(a) * l)}" stroke="${this.pick(["#5c8a2f", "#77a83a"])}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
    this.land.push(g);
  }

  canopy(x: number, y: number, r: number) {
    const dark = this.pick(["#1d5f2a", "#22702f", "#185224"]);
    let g = this.shadow(x, y, r, r * 0.25, r * 0.3);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + this.r(0, 0.5);
      g += `<circle cx="${f(x + Math.cos(a) * r * 0.45)}" cy="${f(y + Math.sin(a) * r * 0.45)}" r="${f(r * 0.55)}" fill="${dark}"/>`;
    }
    g += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.6)}" fill="#2f8a3c"/>`;
    g += `<circle cx="${f(x - r * 0.25)}" cy="${f(y - r * 0.25)}" r="${f(r * 0.32)}" fill="#4caf50" fill-opacity="0.8"/>`;
    this.top.push(g);
  }

  fern(x: number, y: number, r: number) {
    let g = "";
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + this.r(0, 1);
      g += `<path d="M${f(x)} ${f(y)}Q${f(x + Math.cos(a + 0.4) * r * 0.6)} ${f(y + Math.sin(a + 0.4) * r * 0.6)} ${f(x + Math.cos(a) * r)} ${f(y + Math.sin(a) * r)}" stroke="#4caf50" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    }
    this.land.push(g);
  }

  castle(x: number, y: number, r: number, flag = true) {
    let g = `<g transform="translate(${f(x)} ${f(y)})">`;
    g += `<rect x="${f(-r + 5)}" y="${f(-r + 7)}" width="${f(r * 2)}" height="${f(r * 2)}" fill="#000" fill-opacity="0.2"/>`;
    g += `<rect x="${f(-r)}" y="${f(-r)}" width="${f(r * 2)}" height="${f(r * 2)}" fill="#e2c07a" stroke="#b38b4a" stroke-width="2"/>`;
    for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g += `<rect x="${f(cx * r - r * 0.35)}" y="${f(cy * r - r * 0.35)}" width="${f(r * 0.7)}" height="${f(r * 0.7)}" fill="#f0d394" stroke="#b38b4a" stroke-width="2"/>`;
    g += `<rect x="${f(-r * 0.4)}" y="${f(-r * 0.4)}" width="${f(r * 0.8)}" height="${f(r * 0.8)}" fill="#f5dea6"/>`;
    if (flag) g += `<path d="M0 0L0 ${f(-r * 1.1)}" stroke="#6e4a28" stroke-width="2"/><path d="M0 ${f(-r * 1.1)}L${f(r * 0.7)} ${f(-r * 0.9)}L0 ${f(-r * 0.7)}Z" fill="${this.pick(["#ff4d6d", "#4da3ff", "#ffd23f"])}"/>`;
    this.top.push(g + "</g>");
  }

  bucket(x: number, y: number) {
    const c = this.pick(["#ff4d6d", "#4da3ff", "#ffd23f", "#3ddc84"]);
    this.top.push(`<circle cx="${f(x + 3)}" cy="${f(y + 4)}" r="13" fill="#000" fill-opacity="0.2"/><circle cx="${f(x)}" cy="${f(y)}" r="13" fill="${c}"/><circle cx="${f(x)}" cy="${f(y)}" r="9" fill="#e9cf96"/>` +
      `<g transform="translate(${f(x + 16)} ${f(y + 4)}) rotate(${f(this.r(0, 360))})"><rect x="0" y="-2" width="22" height="4" fill="#ffd23f"/><path d="M22 -6L32 -5L32 5L22 6Z" fill="${c}"/></g>`);
  }

  stall(x: number, y: number, a: number) {
    const cols = this.pick([["#ff4d6d", "#ffffff"], ["#ffd23f", "#ff8a3d"], ["#4da3ff", "#ffffff"], ["#b57bff", "#ff8fd1"], ["#3ddc84", "#ffe9a8"]]);
    let g = `<g transform="translate(${f(x)} ${f(y)}) rotate(${f((a * 180) / Math.PI)})">`;
    g += `<rect x="-40" y="-26" width="86" height="58" fill="#000" fill-opacity="0.3"/>`;
    for (let k = 0; k < 6; k++) g += `<rect x="${-42 + k * 14}" y="-30" width="14" height="56" fill="${cols[k % 2]}"/>`;
    g += `<rect x="-42" y="22" width="84" height="6" fill="#ffd23f" fill-opacity="0.9"/>`;
    g += `<circle cx="0" cy="44" r="40" fill="url(#lampglow)"/>`;
    this.top.push(g + "</g>");
  }

  lantern(x: number, y: number) {
    const c = this.pick(["#ff7a1a", "#ffd23f", "#ff4d6d", "#2ee6d6"]);
    this.top.push(`<circle cx="${f(x)}" cy="${f(y)}" r="46" fill="url(#lampglow)"/><circle cx="${f(x)}" cy="${f(y)}" r="7" fill="${c}"/><circle cx="${f(x - 2)}" cy="${f(y - 2)}" r="2.5" fill="#ffffff" fill-opacity="0.8"/>`);
  }

  // ---------- themes ----------

  decorate() {
    const t = this.t;
    switch (this.theme) {
      case "beach": {
        this.many(14, [26, 38], (x, y, r) => this.palm(x, y, r));
        this.many(10, [16, 20], (x, y, r) => this.umbrella(x, y, r), { near: 120 });
        this.many(5, [12, 12], (x, y) => this.ball(x, y), { near: 120 });
        this.many(4, [36, 36], (x, y) => this.surfboard(x, y), { near: 160 });
        this.many(14, [12, 20], (x, y, r) => this.bush(x, y, r));
        this.many(14, [10, 14], (x, y, r) => this.flowers(x, y, r));
        this.many(4, [16, 22], (x, y, r) => this.boat(x, y, r), { sea: true });
        this.many(5, [12, 20], (x, y, r) => this.seaRock(x, y, r), { sea: true });
        break;
      }
      case "harbor": {
        // Piers sticking out to sea from the coast, boats moored beside them.
        for (let k = 0; k < 6; k++) {
          const p = pointAt(t, ((k + 0.5) / 6) * t.length + this.r(-80, 80));
          for (const side of [-1, 1]) {
            const out = t.def.width / 2 + this.look.margin + 20;
            const nx = -Math.sin(p.a) * side, ny = Math.cos(p.a) * side;
            const x = p.x + nx * out, y = p.y + ny * out;
            if (!this.isLand(x - nx * 40, y - ny * 40) || this.isLand(x + nx * 100, y + ny * 100)) continue;
            if (x < 60 || y < 60 || x > t.def.world.w - 60 || y > t.def.world.h - 60) continue;
            this.pier(x - nx * 50, y - ny * 50, Math.atan2(ny, nx), 170);
            this.boat(x + nx * 110 - ny * 34, y + ny * 110 + nx * 34, 18, this.rand() < 0.5);
            this.taken.push({ x: x + nx * 80, y: y + ny * 80, r: 110 });
            break;
          }
        }
        this.many(18, [26, 40], (x, y, r) => this.palm(x, y, r));
        this.many(10, [12, 16], (x, y, r) => this.crate(x, y, r), { near: 110 });
        this.many(10, [10, 13], (x, y, r) => this.barrel(x, y, r), { near: 110 });
        this.many(12, [12, 20], (x, y, r) => this.bush(x, y, r));
        this.many(5, [16, 22], (x, y, r) => this.boat(x, y, r), { sea: true });
        break;
      }
      case "lagoon": {
        this.many(12, [26, 36], (x, y, r) => this.palm(x, y, r));
        this.many(16, [12, 20], (x, y, r) => this.bush(x, y, r));
        this.many(12, [10, 14], (x, y, r) => this.flowers(x, y, r));
        // Lily pads and reeds in the lagoons inside each loop.
        for (let k = 0; k < 40; k++) {
          const p = this.spot(this.r(10, 18), { sea: true, clear: 60 });
          if (!p) continue;
          if (this.rand() < 0.8) this.lily(p.x, p.y, this.r(9, 16));
          else this.reeds(p.x, p.y);
        }
        this.many(6, [12, 18], (x, y, r) => this.seaRock(x, y, r), { sea: true });
        break;
      }
      case "jungle": {
        this.log();
        this.many(40, [34, 60], (x, y, r) => this.canopy(x, y, r), { clear: 10 });
        this.many(30, [14, 22], (x, y, r) => this.fern(x, y, r), { clear: 4 });
        this.many(14, [12, 20], (x, y, r) => this.bush(x, y, r, ["#2f8a3c", "#3d9e48", "#1f6a2c"]));
        this.many(8, [14, 24], (x, y, r) => this.rock(x, y, r, "#6f6a5e", "#9b9584"));
        this.many(10, [10, 14], (x, y, r) => this.flowers(x, y, r));
        break;
      }
      case "volcano": {
        this.crater();
        this.lavaCracks();
        this.many(26, [12, 30], (x, y, r) => this.rock(x, y, r, "#2e2829", "#5a5052"));
        this.many(8, [8, 12], (x, y, r) => this.ember(x, y, r));
        this.many(4, [14, 20], (x, y, r) => this.seaRock(x, y, r), { sea: true });
        break;
      }
      case "night": {
        this.defs.push(`<radialGradient id="lampglow"><stop offset="0" stop-color="#ffd27a" stop-opacity="0.55"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>`);
        this.planks();
        this.lights();
        // Market stalls facing the road.
        for (let k = 0; k < 26; k++) {
          const p = pointAt(t, this.r(0, t.length));
          const side = this.rand() < 0.5 ? -1 : 1;
          const out = t.def.width / 2 + 62;
          const x = p.x - Math.sin(p.a) * out * side, y = p.y + Math.cos(p.a) * out * side;
          if (!this.isLand(x, y, 30) || roadDist(t, x, y) < t.def.width / 2 + 45) continue;
          if (this.taken.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + 50)) continue;
          this.taken.push({ x, y, r: 50 });
          this.stall(x, y, p.a + (side > 0 ? 0 : Math.PI));
        }
        this.many(18, [8, 8], (x, y) => this.lantern(x, y));
        this.many(5, [16, 22], (x, y, r) => this.boat(x, y, r, false), { sea: true });
        this.moon();
        break;
      }
      case "sandcastle": {
        this.walls();
        this.many(10, [20, 30], (x, y, r) => this.castle(x, y, r));
        this.many(10, [14, 14], (x, y) => this.bucket(x, y));
        this.many(8, [16, 20], (x, y, r) => this.umbrella(x, y, r));
        this.many(5, [12, 12], (x, y) => this.ball(x, y));
        this.many(8, [24, 32], (x, y, r) => this.palm(x, y, r));
        this.many(4, [16, 22], (x, y, r) => this.boat(x, y, r), { sea: true });
        break;
      }
    }
  }

  /** Hollow log over a muddy stream for each shortcut (Jungle Switchback). */
  log() {
    for (const sc of this.t.shortcuts) {
      const x0 = sc.path.xs[0], y0 = sc.path.ys[0];
      const x1 = sc.path.xs[sc.path.xs.length - 1], y1 = sc.path.ys[sc.path.ys.length - 1];
      const a = Math.atan2(y1 - y0, x1 - x0);
      const len = Math.hypot(x1 - x0, y1 - y0);
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const w = sc.half * 2 + 10;
      // Stream underneath, running across the log.
      const nx = -Math.sin(a), ny = Math.cos(a);
      this.road.push(`<path d="M${f(mx - nx * 160)} ${f(my - ny * 160)}Q${f(mx + Math.cos(a) * 30)} ${f(my + Math.sin(a) * 30)} ${f(mx + nx * 160)} ${f(my + ny * 160)}" stroke="${this.look.shallow}" stroke-width="56" fill="none" stroke-linecap="round"/>`);
      let g = `<g transform="translate(${f(mx)} ${f(my)}) rotate(${f((a * 180) / Math.PI)})">`;
      g += `<rect x="${f(-len / 2 + 30)}" y="${f(-w / 2 + 8)}" width="${f(len - 60)}" height="${f(w)}" rx="${f(w / 2)}" fill="#000" fill-opacity="0.3"/>`;
      g += `<rect x="${f(-len / 2 + 24)}" y="${f(-w / 2)}" width="${f(len - 48)}" height="${f(w)}" rx="${f(w / 2)}" fill="#7a4f2a" stroke="#4a2e15" stroke-width="3"/>`;
      for (let k = -len / 2 + 40; k < len / 2 - 40; k += 22) g += `<path d="M${f(k)} ${f(-w / 2 + 4)}q6 ${f(w / 2 - 4)} 0 ${f(w - 8)}" stroke="#5a3a1c" stroke-width="2.5" fill="none"/>`;
      // Dark hollow openings at both ends.
      for (const e of [-1, 1]) g += `<ellipse cx="${f(e * (len / 2 - 26))}" cy="0" rx="9" ry="${f(w / 2 - 3)}" fill="#2a170a" stroke="#a87a4a" stroke-width="3"/>`;
      g += `<path d="M${f(-len / 2 + 40)} ${f(-w / 2 + 6)}L${f(len / 2 - 40)} ${f(-w / 2 + 6)}" stroke="#ffffff" stroke-opacity="0.15" stroke-width="3"/>`;
      this.top.push(g + "</g>");
    }
  }

  crater() {
    const t = this.t;
    // Inside of the loop: crater with a glowing lava lake.
    let cx = 0, cy = 0;
    for (let i = 0; i < t.xs.length; i++) (cx += t.xs[i]), (cy += t.ys[i]);
    cx /= t.xs.length;
    cy /= t.ys.length;
    let minD = Infinity;
    for (let i = 0; i < t.xs.length; i++) minD = Math.min(minD, Math.hypot((t.xs[i] - cx) * 0.55, t.ys[i] - cy));
    const ry = Math.max(80, minD - t.def.width / 2 - 70), rx = ry / 0.55;
    this.defs.push(
      `<radialGradient id="lavalake"><stop offset="0" stop-color="#fff3a0"/><stop offset="0.35" stop-color="#ffb02e"/><stop offset="0.7" stop-color="#ff5a1a"/><stop offset="1" stop-color="#8a1c0a"/></radialGradient>`,
      `<radialGradient id="rim"><stop offset="0.6" stop-color="#2a2223"/><stop offset="1" stop-color="#4b403d"/></radialGradient>`,
    );
    this.land.push(
      `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx + 60)}" ry="${f(ry + 50)}" fill="url(#rim)"/>`,
      `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="url(#lavalake)"/>`,
    );
    // Cooled crust islands floating on the lava.
    for (let k = 0; k < 7; k++) {
      const a = this.r(0, Math.PI * 2), d = this.r(0.2, 0.75);
      this.land.push(`<ellipse cx="${f(cx + Math.cos(a) * rx * d)}" cy="${f(cy + Math.sin(a) * ry * d)}" rx="${f(this.r(14, 30))}" ry="${f(this.r(10, 20))}" fill="#3a2a26" fill-opacity="0.85"/>`);
    }
    this.taken.push({ x: cx, y: cy, r: Math.max(rx, ry) + 40 });
  }

  /** The cracks across the road at each lava hazard (the glow is drawn live by the host). */
  lavaCracks() {
    const t = this.t;
    for (const h of t.lavas) {
      const p = pointAt(t, h.s);
      const half = roadHalf(t, h.s) + 8;
      const nx = -Math.sin(p.a), ny = Math.cos(p.a), ax = Math.cos(p.a), ay = Math.sin(p.a);
      const pts: Vec[] = [];
      const n = 9;
      for (let k = 0; k <= n; k++) {
        const u = -half + (2 * half * k) / n;
        const j = (k % 2 ? 1 : -1) * this.r(4, 10);
        pts.push([p.x + nx * u + ax * j, p.y + ny * u + ay * j]);
      }
      const d = `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}`;
      this.over.push(
        `<path d="${d}" stroke="#120c0c" stroke-width="${f(h.len * 1.1)}" fill="none" stroke-linejoin="bevel"/>`,
        `<path d="${d}" stroke="#7a1c08" stroke-width="${f(h.len * 0.45)}" fill="none" stroke-linejoin="bevel"/>`,
      );
    }
  }

  ember(x: number, y: number, r: number) {
    this.land.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 2.2)}" fill="#ff5a1a" fill-opacity="0.18"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.6)}" fill="#ffb02e"/>`);
  }

  /** Boardwalk road: plank seams across the road and rails along both edges. */
  planks() {
    const t = this.t, road = loopPath(t);
    this.road.push(
      `<path d="${road}" fill="none" stroke="#5e3d22" stroke-width="${t.def.width}" stroke-dasharray="2.5 16" stroke-linejoin="round"/>`,
      `<path d="${road}" fill="none" stroke="#000" stroke-opacity="0.12" stroke-width="${t.def.width * 0.5}" stroke-linejoin="round"/>`,
    );
  }

  /** Street lamps along the road + string lights. */
  lights() {
    const t = this.t;
    for (let s = 0; s < t.length; s += 210) {
      const p = pointAt(t, s);
      for (const side of [-1, 1]) {
        const out = t.def.width / 2 + 16;
        const x = p.x - Math.sin(p.a) * out * side, y = p.y + Math.cos(p.a) * out * side;
        if (roadDist(t, x, y) < t.def.width / 2 + 8) continue;
        this.over.push(`<circle cx="${f(x - Math.sin(p.a) * -side * 40)}" cy="${f(y + Math.cos(p.a) * -side * 40)}" r="80" fill="url(#lampglow)"/>`);
        this.top.push(`<circle cx="${f(x)}" cy="${f(y)}" r="6" fill="#2a2638" stroke="#ffe9a8" stroke-width="3"/>`);
      }
    }
    // String lights zig-zagging over the road every so often.
    const cols = ["#ff4d6d", "#ffd23f", "#2ee6d6", "#b57bff", "#3ddc84"];
    for (let s = 105; s < t.length; s += 420) {
      const p = pointAt(t, s);
      const half = t.def.width / 2 + 20;
      const nx = -Math.sin(p.a), ny = Math.cos(p.a);
      const a: Vec = [p.x - nx * half, p.y - ny * half], b: Vec = [p.x + nx * half, p.y + ny * half];
      let g = `<path d="M${f(a[0])} ${f(a[1])}Q${f(p.x + Math.cos(p.a) * 18)} ${f(p.y + Math.sin(p.a) * 18)} ${f(b[0])} ${f(b[1])}" stroke="#1a1626" stroke-width="2" fill="none"/>`;
      for (let k = 1; k < 8; k++) {
        const u = k / 8;
        const x = (1 - u) ** 2 * a[0] + 2 * (1 - u) * u * (p.x + Math.cos(p.a) * 18) + u * u * b[0];
        const y = (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * (p.y + Math.sin(p.a) * 18) + u * u * b[1];
        g += `<circle cx="${f(x)}" cy="${f(y)}" r="7" fill="${cols[k % cols.length]}" fill-opacity="0.3"/><circle cx="${f(x)}" cy="${f(y)}" r="3.2" fill="${cols[k % cols.length]}"/>`;
      }
      this.top.push(g);
    }
  }

  moon() {
    const { w, h } = this.t.def.world;
    // Moonlight reflection: a shimmering column on the water near a corner.
    const spot = this.spot(40, { sea: true, clear: 120, tries: 200 }) ?? { x: w - 90, y: 90 };
    let g = "";
    for (let k = 0; k < 9; k++) g += `<rect x="${f(spot.x - this.r(10, 40))}" y="${f(spot.y - 70 + k * 16)}" width="${f(this.r(30, 80))}" height="4" rx="2" fill="#e9f0ff" fill-opacity="${f(0.15 + this.rand() * 0.3)}"/>`;
    this.land.push(g);
    void h;
  }

  /** Sandcastle walls along both road edges, with towers. */
  walls() {
    const t = this.t, road = loopPath(t), w = t.def.width;
    this.road.splice(
      0,
      this.road.length,
      `<path d="${road}" fill="none" stroke="#000" stroke-opacity="0.2" stroke-width="${w + 56}" stroke-linejoin="round" transform="translate(5 7)"/>`,
      `<path d="${road}" fill="none" stroke="#c9a063" stroke-width="${w + 52}" stroke-linejoin="round"/>`,
      `<path d="${road}" fill="none" stroke="#e9c98a" stroke-width="${w + 52}" stroke-linejoin="round" stroke-dasharray="16 10"/>`,
      `<path d="${road}" fill="none" stroke="#b38b4a" stroke-width="${w + 8}" stroke-linejoin="round"/>`,
      `<path d="${road}" fill="none" stroke="${this.look.road}" stroke-width="${w}" stroke-linejoin="round"/>`,
      // Red-white rumble strip just inside the walls.
      `<path d="${road}" fill="none" stroke="#ffffff" stroke-width="${w - 4}" stroke-linejoin="round" stroke-opacity="0.9"/>`,
      `<path d="${road}" fill="none" stroke="#e8453c" stroke-width="${w - 4}" stroke-linejoin="round" stroke-dasharray="18 18"/>`,
      `<path d="${road}" fill="none" stroke="${this.look.road}" stroke-width="${w - 20}" stroke-linejoin="round"/>`,
    );
    // Towers on the walls.
    for (let s = 60; s < t.length; s += 330) {
      const p = pointAt(t, s);
      for (const side of [-1, 1]) {
        const out = w / 2 + 22;
        const x = p.x - Math.sin(p.a) * out * side, y = p.y + Math.cos(p.a) * out * side;
        if (roadDist(t, x, y) < w / 2 + 12) continue;
        this.castle(x, y, 15, side > 0);
      }
    }
  }

  render(): string {
    const { w, h } = this.t.def.world;
    this.sea();
    this.island();
    this.channelsCut();
    this.roadway();
    this.bridges();
    this.surfaces();
    this.centerAndStart();
    this.decorate();
    return svg(w, h, w, h, [`<defs>${this.defs.join("")}</defs>`, ...this.under, ...this.land, ...this.road, ...this.over, ...this.top]);
  }
}

function minimap(t: Track): string {
  const { w, h } = t.def.world;
  const scale = 320 / w;
  const road = loopPath(t);
  const parts = [
    `<path d="${road}" fill="none" stroke="#0b1d2a" stroke-opacity="0.6" stroke-width="${t.def.width * 1.4}" stroke-linejoin="round"/>`,
    `<path d="${road}" fill="none" stroke="#ffffff" stroke-width="${t.def.width * 0.8}" stroke-linejoin="round"/>`,
  ];
  for (const b of t.bridges) parts.push(`<path d="${pathAlong(t, b.s0, b.s1, 6)}" fill="none" stroke="#b07a43" stroke-width="${t.def.width * 0.8}"/>`);
  for (const sc of t.shortcuts) {
    const d = `M${f(sc.path.xs[0])} ${f(sc.path.ys[0])}L${f(sc.path.xs[sc.path.xs.length - 1])} ${f(sc.path.ys[sc.path.ys.length - 1])}`;
    parts.push(`<path d="${d}" fill="none" stroke="#b07a43" stroke-width="${sc.half * 2}" stroke-dasharray="${sc.half} ${sc.half / 2}"/>`);
  }
  for (const s of t.def.surfaces) {
    if (s.kind === "water") parts.push(`<path d="${poly(s.poly)}" fill="#5fc3ef" fill-opacity="0.8"/>`);
    if (s.kind === "ash") parts.push(`<path d="${poly(s.poly)}" fill="#8f8a84" fill-opacity="0.7"/>`);
  }
  for (const l of t.lavas) {
    const p = pointAt(t, l.s);
    parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(t.def.width * 0.45)}" fill="#ff5a1a"/>`);
  }
  for (const c of t.crabs) {
    const p = pointAt(t, c.s);
    parts.push(`<circle cx="${f(p.x)}" cy="${f(p.y)}" r="${f(t.def.width * 0.45)}" fill="#ff4d6d"/>`);
  }
  if (t.walls) parts.splice(1, 0, `<path d="${road}" fill="none" stroke="#e9c98a" stroke-width="${t.def.width * 1.15}" stroke-linejoin="round"/>`);
  return svg(Math.round(w * scale), Math.round(h * scale), w, h, parts);
}

function svg(pw: number, ph: number, w: number, h: number, parts: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}" viewBox="0 0 ${w} ${h}">\n${parts.join("\n")}\n</svg>\n`;
}

for (const file of readdirSync(DIR).filter((n) => n.endsWith(".json"))) {
  const def = parseTrack(JSON.parse(readFileSync(join(DIR, file), "utf8")));
  const t = buildTrack(def);
  const bg = new Art(t, def.theme ?? "beach").render();
  writeFileSync(join("public", def.background), bg);
  writeFileSync(join("public", def.minimap), minimap(t));
  console.log(`${def.id}: ${def.background} (${Math.round(bg.length / 1024)} KB), ${def.minimap}`);
}
