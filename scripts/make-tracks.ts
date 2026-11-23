// Writes the layouts of the generated tracks to public/assets/tracks/<id>.json, then
// `npm run tracks` draws their images. Hand-made tracks (Sunny Cove, Coconut Harbor,
// Lagoon Figure-8) are not touched except for their theme/difficulty labels.
// Run:  npx tsx scripts/make-tracks.ts && npm run tracks

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hazard, Surface, Theme, TrackFile, Vec } from "../shared/track-format";
import { trackProblems } from "../shared/track-format";

const DIR = join(import.meta.dirname, "..", "public", "assets", "tracks");
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------- path building ----------

/** A path made of straight lines and arcs, sampled densely. Starts at `start` heading `dir` (rad). */
class Pen {
  pts: Vec[] = [];
  constructor(public x: number, public y: number, public a: number) {
    this.pts.push([x, y]);
  }
  line(len: number) {
    const n = Math.max(1, Math.ceil(len / 4));
    for (let i = 1; i <= n; i++) this.pts.push([this.x + Math.cos(this.a) * (len * i) / n, this.y + Math.sin(this.a) * (len * i) / n]);
    this.x += Math.cos(this.a) * len;
    this.y += Math.sin(this.a) * len;
    return this;
  }
  /** Turn by `deg` (positive = clockwise on screen, i.e. to the right) on a circle of radius r. */
  arc(deg: number, r: number) {
    const turn = (deg * Math.PI) / 180;
    const side = Math.sign(turn);
    const cx = this.x - Math.sin(this.a) * r * side, cy = this.y + Math.cos(this.a) * r * side;
    const a0 = Math.atan2(this.y - cy, this.x - cx);
    const n = Math.max(2, Math.ceil((Math.abs(turn) * r) / 4));
    for (let i = 1; i <= n; i++) {
      const ang = a0 + (turn * i) / n;
      this.pts.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
    }
    this.a += turn;
    [this.x, this.y] = this.pts[this.pts.length - 1];
    return this;
  }
}

/** Closed loop from a polar function around a center: r(θ) → point. Starts at θ0, θ increasing. */
function polar(cx: number, cy: number, rx: number, ry: number, k: (th: number) => number, th0: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < 2000; i++) {
    const th = th0 + (i / 2000) * Math.PI * 2;
    out.push([cx + Math.cos(th) * rx * k(th), cy + Math.sin(th) * ry * k(th)]);
  }
  return out;
}

/** Resample a dense closed path to n evenly spaced points (point 0 stays first). */
function resample(dense: Vec[], n: number): Vec[] {
  const pts = [...dense];
  const first = pts[0], last = pts[pts.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1) pts.pop();
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[cum.length - 1];
  const out: Vec[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * L;
    while (cum[j + 1] < s) j++;
    const a = pts[j], b = pts[(j + 1) % pts.length];
    const u = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push([r1(a[0] + (b[0] - a[0]) * u), r1(a[1] + (b[1] - a[1]) * u)]);
  }
  return out;
}

function loopLength(p: Vec[]): number {
  let L = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

/** Nearest centerline index to a point. */
function nearest(cl: Vec[], x: number, y: number): number {
  let best = 0, bd = Infinity;
  cl.forEach(([px, py], i) => {
    const d = Math.hypot(px - x, py - y);
    if (d < bd) (bd = d), (best = i);
  });
  return best;
}

/** 8 grid slots behind the start line, two abreast. */
function grid(cl: Vec[], width: number): [number, number, number][] {
  // Walk backwards along the loop from point 0.
  const back: { x: number; y: number; a: number; s: number }[] = [];
  let s = 0;
  for (let i = cl.length; i > cl.length - 20; i--) {
    const a = cl[i % cl.length], b = cl[(i - 1) % cl.length];
    const seg = Math.hypot(a[0] - b[0], a[1] - b[1]);
    back.push({ x: a[0], y: a[1], a: Math.atan2(a[1] - b[1], a[0] - b[0]), s });
    s += seg;
  }
  const at = (d: number) => {
    let k = 0;
    while (k + 1 < back.length && back[k + 1].s <= d) k++;
    const p = back[k], q = back[k + 1] ?? p;
    const u = q.s > p.s ? (d - p.s) / (q.s - p.s) : 0;
    return { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, a: p.a };
  };
  const lat = Math.min(40, width * 0.27);
  return Array.from({ length: 8 }, (_, i) => {
    const row = i >> 1, side = i % 2 ? 1 : -1;
    const p = at(50 + row * 48);
    const nx = -Math.sin(p.a), ny = Math.cos(p.a);
    return [r1(p.x + nx * lat * side), r1(p.y + ny * lat * side), Math.round(p.a * 1000) / 1000] as [number, number, number];
  });
}

/** Trap zones from fractions of the lap, kept ≥ 2 s (at top speed) from the start line. */
function zones(cl: Vec[], fr: [number, number][]): Vec[] {
  const n = cl.length;
  const L = loopLength(cl);
  const minIdx = Math.ceil((560 / L) * n), maxIdx = Math.floor(((L - 560) / L) * n);
  return fr.map(([a, b]) => [Math.max(minIdx, Math.round(a * n)), Math.min(maxIdx, Math.round(b * n))] as Vec).filter(([a, b]) => a < b);
}

function rect(cx: number, cy: number, w: number, h: number, ang: number): Vec[] {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => [r1(cx + x * c - y * s), r1(cy + x * s + y * c)] as Vec);
}

interface Spec {
  id: string;
  name: string;
  theme: Theme;
  difficulty: "easy" | "medium" | "hard";
  world: { w: number; h: number };
  width: number;
  dense: Vec[];
  zones: [number, number][];
  hazards?: (cl: Vec[]) => Hazard[];
  surfaces?: (cl: Vec[]) => Surface[];
}

function build(spec: Spec): TrackFile {
  const L = loopLength(spec.dense);
  const n = Math.max(48, Math.min(120, Math.round(L / 55)));
  const cl = resample(spec.dense, n);
  return {
    id: spec.id,
    name: spec.name,
    version: 1,
    theme: spec.theme,
    difficulty: spec.difficulty,
    world: spec.world,
    centerline: cl,
    width: spec.width,
    checkpoints: [0, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4)],
    startGrid: grid(cl, spec.width),
    surfaces: spec.surfaces?.(cl) ?? [],
    hazards: spec.hazards?.(cl) ?? [],
    trapZones: zones(cl, spec.zones),
    racingLine: cl,
    background: `/assets/tracks/${spec.id}.bg.svg`,
    minimap: `/assets/tracks/${spec.id}.minimap.svg`,
  };
}

// ---------- the tracks ----------

const W = { w: 1800, h: 1000 };

const specs: Spec[] = [
  {
    // Beginner track: wide road, gentle bean shape, walls on both edges so nobody can go off.
    id: "sandcastle-circuit",
    name: "Sandcastle Circuit",
    theme: "sandcastle",
    difficulty: "easy",
    world: W,
    width: 150,
    dense: polar(900, 500, 640, 330, (th) => 1 - 0.2 * Math.exp(-((th - 1.5 * Math.PI) ** 2) / 0.35), Math.PI / 2),
    zones: [[0.15, 0.42], [0.55, 0.85]],
    hazards: () => [{ kind: "walls" }],
  },
  {
    // Hairpins up and down the hill; a hollow log cuts across the first bottom hairpin (one car wide).
    id: "jungle-switchback",
    name: "Jungle Switchback",
    theme: "jungle",
    difficulty: "medium",
    world: W,
    width: 100,
    dense: new Pen(620, 870, 0)
      .line(780)
      .arc(-90, 150) // up the right side
      .line(380)
      .arc(-180, 125) // top hairpin, now heading down
      .line(260)
      .arc(180, 115) // bottom hairpin (the log cuts this one)
      .line(260)
      .arc(-180, 115) // top hairpin
      .line(260)
      .arc(180, 115) // bottom hairpin
      .line(260)
      .arc(-180, 125) // top hairpin, heading down the left side
      .line(390)
      .arc(-90, 140)
      .line(120).pts,
    zones: [[0.12, 0.3], [0.42, 0.62], [0.72, 0.86]],
    hazards: (cl) => {
      // Log across the first bottom hairpin: from the down leg to the up leg, above the turn.
      const legA = 1300, y = 500;
      const a = nearest(cl, legA, y);
      const b = nearest(cl, legA - 230, y);
      return [{ kind: "shortcut", from: Math.min(a, b), to: Math.max(a, b), width: 46, path: [cl[Math.min(a, b)], cl[Math.max(a, b)]] }];
    },
  },
  {
    // Loop around a crater: lava cracks open on a rhythm, ash patches have low grip.
    id: "volcano-rim",
    name: "Volcano Rim",
    theme: "volcano",
    difficulty: "hard",
    world: W,
    width: 105,
    dense: polar(900, 510, 660, 350, (th) => 1 + 0.09 * Math.sin(3 * th + 0.6) + 0.05 * Math.sin(5 * th), Math.PI / 2),
    zones: [[0.1, 0.3], [0.38, 0.6], [0.68, 0.9]],
    hazards: (cl) => {
      const n = cl.length;
      return [
        { kind: "lava", at: Math.round(n * 0.22), len: 34, period: 240, open: 80, offset: 0 },
        { kind: "lava", at: Math.round(n * 0.52), len: 34, period: 240, open: 80, offset: 120 },
        { kind: "lava", at: Math.round(n * 0.8), len: 34, period: 300, open: 100, offset: 60 },
      ];
    },
    surfaces: (cl) => {
      const n = cl.length;
      const patch = (f: number, len: number): Surface => {
        const i = Math.round(n * f);
        const [x0, y0] = cl[i], [x1, y1] = cl[(i + 1) % n];
        return { kind: "ash", poly: rect(x0, y0, len, 150, Math.atan2(y1 - y0, x1 - x0)) };
      };
      return [patch(0.36, 220), patch(0.66, 240)];
    },
  },
  {
    // Night city loop with square corners; crab crowds cross the road at set moments.
    id: "boardwalk-night-market",
    name: "Boardwalk Night Market",
    theme: "night",
    difficulty: "medium",
    world: W,
    width: 110,
    dense: new Pen(700, 860, 0)
      .line(640)
      .arc(-90, 120)
      .line(480)
      .arc(-90, 120)
      .line(300)
      .arc(-90, 110)
      .line(150)
      .arc(90, 110)
      .line(150)
      .arc(90, 110)
      .line(150)
      .arc(-90, 110)
      .line(200)
      .arc(-90, 120)
      .line(480)
      .arc(-90, 120)
      .line(450).pts,
    zones: [[0.1, 0.3], [0.36, 0.62], [0.7, 0.9]],
    hazards: (cl) => {
      const n = cl.length;
      return [
        { kind: "crabs", at: Math.round(n * 0.27), period: 300, cross: 150, offset: 0 },
        { kind: "crabs", at: Math.round(n * 0.75), period: 360, cross: 150, offset: 170 },
      ];
    },
  },
];

for (const spec of specs) {
  const def = build(spec);
  const problems = trackProblems(def);
  if (problems.length) throw new Error(`${spec.id}: ${problems.join("; ")}`);
  writeFileSync(join(DIR, `${spec.id}.json`), JSON.stringify(def, null, 1) + "\n");
  console.log(`${spec.id}: ${def.centerline.length} points, lap ${Math.round(loopLength(def.centerline))} px, zones ${JSON.stringify(def.trapZones)}`);
}

// Labels on the hand-made tracks.
const labels: Record<string, { theme: Theme; difficulty: "easy" | "medium" | "hard" }> = {
  "sunny-cove": { theme: "beach", difficulty: "easy" },
  "coconut-harbor": { theme: "harbor", difficulty: "easy" },
  "lagoon-figure8": { theme: "lagoon", difficulty: "medium" },
};
for (const [id, l] of Object.entries(labels)) {
  const path = join(DIR, `${id}.json`);
  const def = JSON.parse(readFileSync(path, "utf8"));
  if (def.theme === l.theme && def.difficulty === l.difficulty) continue;
  Object.assign(def, l);
  writeFileSync(path, JSON.stringify(def, null, 2) + "\n");
  console.log(`${id}: labelled ${l.theme}/${l.difficulty}`);
}
