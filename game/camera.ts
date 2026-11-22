// Broadcast camera for the host screen (PLAN.md section 5b). Pure math, no Phaser:
// the scene feeds car positions in once per frame and applies the shot that comes out.
// Never sends anything over the network.

import { COUNTDOWN_MS } from "../shared/constants";

export interface Shot {
  cx: number;
  cy: number;
  zoom: number;
}
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface CarPos {
  pid: string;
  x: number;
  y: number;
  a: number;
  /** Unwrapped progress; bigger = further ahead. */
  dist: number;
  finished: boolean;
}
export interface View {
  w: number;
  h: number;
}

export const CAM = {
  carLen: 38,
  /** Never closer than this many car lengths across the screen's short side. */
  minCarLengths: 3,
  /** The pack frame is at least this many car lengths across, so a lone car isn't filmed from 1 m away. */
  packMinCars: 12,
  /** Space kept around the outermost cars (world px). */
  padPx: 110,
  /** Leader bias: frame includes a point this far ahead of the leader (≈ 0.7 s at top speed). */
  leadPx: 180,
  /** Drop the last car into the corner window only when framing everyone would need nearly
   *  the whole-track zoom ("instead of zooming all the way out"). */
  stragglerAt: 1.15,
  /** Smoothing rates (per second) for position and zoom. Higher = snappier. */
  kPos: 2.5,
  kZoom: 2,
  kCut: 7,
  introMs: 1200,
  cutMs: 1500,
  cutGapMs: 5000,
  cutCars: 9,
  slowmo: 0.5,
  /** Finish shot starts when the leader is this close to the line on the last lap. */
  finishPx: 520,
  finishCars: 16,
  /** Hold the finish shot this long after the first car crosses. */
  finishHoldMs: 2500,
};

export function bbox(points: { x: number; y: number }[]): Rect {
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of points) {
    r.x0 = Math.min(r.x0, p.x);
    r.y0 = Math.min(r.y0, p.y);
    r.x1 = Math.max(r.x1, p.x);
    r.y1 = Math.max(r.y1, p.y);
  }
  return r;
}

export function pad(r: Rect, px: number): Rect {
  return { x0: r.x0 - px, y0: r.y0 - px, x1: r.x1 + px, y1: r.y1 + px };
}

/** Zoom that fits a world rect into the view. */
export function fitZoom(r: Rect, v: View): number {
  return Math.min(v.w / Math.max(1, r.x1 - r.x0), v.h / Math.max(1, r.y1 - r.y0));
}

export function zoomLimits(v: View, track: Rect): { min: number; max: number } {
  const max = Math.min(v.w, v.h) / (CAM.minCarLengths * CAM.carLen);
  return { min: Math.min(fitZoom(track, v), max), max };
}

export const clampZoom = (z: number, v: View, track: Rect) => {
  const { min, max } = zoomLimits(v, track);
  return Math.max(min, Math.min(max, z));
};

export function wideShot(v: View, track: Rect): Shot {
  return { cx: (track.x0 + track.x1) / 2, cy: (track.y0 + track.y1) / 2, zoom: zoomLimits(v, track).min };
}

/** Shot centered on a point, showing about `cars` car lengths across the short side. */
export function closeShot(x: number, y: number, cars: number, v: View, track: Rect): Shot {
  return { cx: x, cy: y, zoom: clampZoom(Math.min(v.w, v.h) / (cars * CAM.carLen), v, track) };
}

/**
 * Frame the pack: all cars plus a point ahead of the leader, padded. If that needs zooming out
 * too far, cars at the back are left out; the last one left out goes to the corner window.
 */
export function packShot(cars: CarPos[], v: View, track: Rect, leaderBias = true): { shot: Shot; straggler: string | null } {
  if (cars.length === 0) return { shot: wideShot(v, track), straggler: null };
  const order = [...cars].sort((a, b) => b.dist - a.dist);
  const lead = order[0];
  const ahead = leaderBias ? [{ x: lead.x + Math.cos(lead.a) * CAM.leadPx, y: lead.y + Math.sin(lead.a) * CAM.leadPx }] : [];
  const { min } = zoomLimits(v, track);
  let straggler: string | null = null;
  let n = order.length;
  for (;;) {
    const r = minSpan(pad(bbox([...order.slice(0, n), ...ahead]), CAM.padPx), CAM.packMinCars * CAM.carLen);
    const z = fitZoom(r, v);
    if (z < min * CAM.stragglerAt && n > 1) {
      straggler ??= order[n - 1].pid;
      n--;
      continue;
    }
    return { shot: { cx: (r.x0 + r.x1) / 2, cy: (r.y0 + r.y1) / 2, zoom: clampZoom(z, v, track) }, straggler };
  }
}

function minSpan(r: Rect, span: number): Rect {
  const gx = Math.max(0, span - (r.x1 - r.x0)) / 2;
  const gy = Math.max(0, span - (r.y1 - r.y0)) / 2;
  return { x0: r.x0 - gx, y0: r.y0 - gy, x1: r.x1 + gx, y1: r.y1 + gy };
}

/** Keep the visible area inside the world (no empty sea past the map edge); center it if the
 *  world is smaller than the view on an axis. */
export function clampToWorld(s: Shot, v: View, world: Rect): Shot {
  const hw = v.w / 2 / s.zoom, hh = v.h / 2 / s.zoom;
  const axis = (c: number, half: number, lo: number, hi: number) => (hi - lo <= half * 2 ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, c)));
  return { cx: axis(s.cx, hw, world.x0, world.x1), cy: axis(s.cy, hh, world.y0, world.y1), zoom: s.zoom };
}

/** Frame-rate independent smoothing toward a target. Zoom moves in log space so in/out feel equal. */
export function follow(cur: Shot, target: Shot, dtMs: number, kPos = CAM.kPos, kZoom = CAM.kZoom): Shot {
  const ap = 1 - Math.exp((-kPos * dtMs) / 1000);
  const az = 1 - Math.exp((-kZoom * dtMs) / 1000);
  return {
    cx: cur.cx + (target.cx - cur.cx) * ap,
    cy: cur.cy + (target.cy - cur.cy) * ap,
    zoom: Math.exp(Math.log(cur.zoom) + (Math.log(target.zoom) - Math.log(cur.zoom)) * az),
  };
}

export type ShotKind = "wide" | "intro" | "grid" | "pack" | "cut" | "finish";

export interface DirectorInput {
  nowMs: number;
  dtMs: number;
  phase: "lobby" | "countdown" | "race" | "results";
  countdownLeft: number;
  cars: CarPos[];
  /** Physics tick right now (for the slow-motion replay). */
  tick: number;
  finishLine: { x: number; y: number };
  /** Distance at which a car finishes (laps × track length). */
  finishDist: number;
  view: View;
  track: Rect;
  /** Whole background image; the camera never shows past it when zoomed in. */
  world: Rect;
  /** Screen px covered by HUD on each side (positions tower etc.); shots are framed in the rest. */
  insets?: { l: number; r: number; t: number; b: number };
}

export interface DirectorOutput {
  shot: Shot;
  kind: ShotKind;
  straggler: string | null;
  /** While set, the host draws cars from recorded poses at 0.5× speed from this tick. */
  slowmo: { fromTick: number; sinceMs: number } | null;
}

/** Picks and smooths the shot each frame: intro → grid → pack, trap cuts, finish line. */
export class Director {
  private cur: Shot | null = null;
  private cut: { x: number; y: number; atMs: number; tick: number } | null = null;
  private lastCutMs = -Infinity;
  private firstFinishMs: number | null = null;
  private lastPhase = "";

  /** A trap went off at (x, y). Returns false if a cut happened less than 5 s ago. */
  trapHit(x: number, y: number, nowMs: number, tick: number): boolean {
    if (nowMs - this.lastCutMs < CAM.cutGapMs) return false;
    this.cut = { x, y, atMs: nowMs, tick };
    this.lastCutMs = nowMs;
    return true;
  }

  update(i: DirectorInput): DirectorOutput {
    const ins = i.insets ?? { l: 0, r: 0, t: 0, b: 0 };
    const full = i.view;
    // Frame everything inside the part of the screen the HUD leaves free...
    const v = { w: Math.max(100, full.w - ins.l - ins.r), h: Math.max(100, full.h - ins.t - ins.b) };
    const { track } = i;
    let kind: ShotKind = "pack";
    let target: Shot;
    let straggler: string | null = null;
    let snap = false;
    let k = { pos: CAM.kPos, zoom: CAM.kZoom };
    let slowmo: DirectorOutput["slowmo"] = null;

    if (i.phase !== this.lastPhase) {
      if (i.phase === "countdown") {
        snap = true; // new race: start on the wide shot
        this.firstFinishMs = null;
        this.cut = null;
      }
      this.lastPhase = i.phase;
    }
    if (i.phase === "race" && this.firstFinishMs === null && i.cars.some((c) => c.finished)) this.firstFinishMs = i.nowMs;

    const leader = i.cars.reduce<CarPos | null>((b, c) => (!b || c.dist > b.dist ? c : b), null);

    if (i.phase === "lobby" || i.phase === "results" || !leader) {
      kind = "wide";
      target = wideShot(v, track);
    } else if (i.phase === "countdown") {
      if (COUNTDOWN_MS - i.countdownLeft < CAM.introMs) {
        kind = "intro";
        target = wideShot(v, track);
      } else {
        kind = "grid";
        target = packShot(i.cars, v, track, false).shot;
        k = { pos: 3, zoom: 3 };
      }
    } else if (this.cut && i.nowMs - this.cut.atMs < CAM.cutMs) {
      kind = "cut";
      target = closeShot(this.cut.x, this.cut.y, CAM.cutCars, v, track);
      k = { pos: CAM.kCut, zoom: CAM.kCut };
      slowmo = { fromTick: this.cut.tick, sinceMs: this.cut.atMs };
    } else {
      if (this.cut) {
        this.cut = null;
        snap = true; // cut straight back to live
      }
      const nearLine = leader.dist >= i.finishDist - CAM.finishPx;
      const holding = this.firstFinishMs !== null && i.nowMs - this.firstFinishMs < CAM.finishHoldMs;
      if ((nearLine && this.firstFinishMs === null) || holding) {
        kind = "finish";
        target = closeShot(i.finishLine.x, i.finishLine.y, CAM.finishCars, v, track);
      } else {
        const p = packShot(i.cars.filter((c) => !c.finished || i.cars.every((x) => x.finished)), v, track);
        target = p.shot;
        straggler = p.straggler;
      }
    }

    // ...then shift so that free area's middle lands on the shot's center.
    target = { ...target, cx: target.cx + (ins.r - ins.l) / 2 / target.zoom, cy: target.cy + (ins.b - ins.t) / 2 / target.zoom };
    // The HUD hides its strip anyway, so the view may run past the world under it.
    const z = target.zoom;
    const w = i.world;
    target = clampToWorld(target, full, { x0: w.x0 - ins.l / z, y0: w.y0 - ins.t / z, x1: w.x1 + ins.r / z, y1: w.y1 + ins.b / z });
    this.cur = !this.cur || snap ? target : follow(this.cur, target, i.dtMs, k.pos, k.zoom);
    return { shot: this.cur, kind, straggler, slowmo };
  }
}
