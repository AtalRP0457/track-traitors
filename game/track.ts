// Track geometry: a closed centerline + road width. Pure math, no Phaser, so it can run
// anywhere (host, tests, later the server for lap re-simulation).

import type { SurfaceKind, TrackFile, Vec } from "../shared/track-format";

export interface Loop {
  /** Dense samples along a smoothed closed loop. */
  xs: Float64Array;
  ys: Float64Array;
  /** Distance along the loop at each sample. */
  ds: Float64Array;
  length: number;
}

export interface Track extends Loop {
  def: TrackFile;
  /** Distance along the centerline of each checkpoint (first is 0, the start line). */
  cps: number[];
  /** Smoothed racing line for bots. */
  line: Loop;
  /** Narrow one-car bridges (hazard kind "bridge"): [from, to) distance along the centerline + half width. */
  bridges: { s0: number; s1: number; half: number }[];
  /** Road edges are walls (hazard kind "walls"): cars slide along them and can't leave the road. */
  walls: boolean;
  /** Narrow side paths (hazard kind "shortcut"), e.g. a hollow log cutting a hairpin. */
  shortcuts: Shortcut[];
  /** Lava cracks across the road that open on a rhythm (hazard kind "lava"). */
  lavas: Timed[];
  /** Crab crowds that walk across the road at set moments (hazard kind "crabs"). */
  crabs: Timed[];
}

export interface Shortcut {
  /** Centerline distances where it leaves and rejoins the road. */
  s0: number;
  s1: number;
  half: number;
  /** Dense path and distance along it. */
  path: Loop;
}

/** A hazard at centerline distance s that is active `on` ticks of every `period`, shifted by `offset`. */
export interface Timed {
  s: number;
  /** Half its length along the track (px). */
  len: number;
  period: number;
  on: number;
  offset: number;
}

/** Is a timed hazard active at this tick? warn = this many ticks before it starts also count. */
export function timedOn(h: Timed, tick: number, warn = 0): boolean {
  const p = (((tick + h.offset + warn) % h.period) + h.period) % h.period;
  return p < h.on + warn;
}

/** 0 → 1 progress through the active window (crabs walking across), or -1 when inactive. */
export function timedPhase(h: Timed, tick: number): number {
  const p = (((tick + h.offset) % h.period) + h.period) % h.period;
  return p < h.on ? p / h.on : -1;
}

export const SAMPLES_PER_SEGMENT = 8;

/** Smooth closed control points with a Catmull-Rom spline and sample densely. */
export function smoothLoop(p: Vec[]): Loop {
  const n = p.length;
  const total = n * SAMPLES_PER_SEGMENT;
  const xs = new Float64Array(total);
  const ys = new Float64Array(total);
  for (let i = 0; i < n; i++) {
    const [x0, y0] = p[(i - 1 + n) % n];
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % n];
    const [x3, y3] = p[(i + 2) % n];
    for (let j = 0; j < SAMPLES_PER_SEGMENT; j++) {
      const t = j / SAMPLES_PER_SEGMENT;
      const t2 = t * t;
      const t3 = t2 * t;
      const k = i * SAMPLES_PER_SEGMENT + j;
      xs[k] = 0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      ys[k] = 0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
    }
  }
  const ds = new Float64Array(total);
  let len = 0;
  for (let k = 0; k < total; k++) {
    ds[k] = len;
    const k2 = (k + 1) % total;
    len += Math.hypot(xs[k2] - xs[k], ys[k2] - ys[k]);
  }
  return { xs, ys, ds, length: len };
}

/** Dense, open polyline (no smoothing) with distances, for shortcut paths. */
function openPath(p: Vec[]): Loop {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 6));
    for (let j = 0; j < n; j++) xs.push(x0 + ((x1 - x0) * j) / n), ys.push(y0 + ((y1 - y0) * j) / n);
  }
  xs.push(p[p.length - 1][0]);
  ys.push(p[p.length - 1][1]);
  const ds = new Float64Array(xs.length);
  for (let k = 1; k < xs.length; k++) ds[k] = ds[k - 1] + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), ds, length: ds[ds.length - 1] };
}

const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);

/** Build the runtime track from a (validated) track file. */
export function buildTrack(def: TrackFile): Track {
  const loop = smoothLoop(def.centerline);
  const at = (i: unknown) => loop.ds[(Math.round(num(i, 0)) % def.centerline.length) * SAMPLES_PER_SEGMENT];
  const timed = (kind: string, onKey: string, len: number) =>
    def.hazards
      .filter((h) => h.kind === kind && Number.isInteger(h.at))
      .map((h) => ({ s: at(h.at), len: num(h.len, len) / 2, period: Math.max(1, num(h.period, 240)), on: num(h[onKey], 60), offset: num(h.offset, 0) }));
  return {
    def,
    ...loop,
    cps: def.checkpoints.map((i) => loop.ds[i * SAMPLES_PER_SEGMENT]),
    line: smoothLoop(def.racingLine),
    bridges: def.hazards
      .filter((h) => h.kind === "bridge" && Number.isInteger(h.from) && Number.isInteger(h.to) && typeof h.width === "number")
      .map((h) => ({ s0: loop.ds[(h.from as number) * SAMPLES_PER_SEGMENT], s1: loop.ds[(h.to as number) * SAMPLES_PER_SEGMENT], half: (h.width as number) / 2 })),
    walls: def.hazards.some((h) => h.kind === "walls"),
    shortcuts: def.hazards
      .filter((h) => h.kind === "shortcut" && Number.isInteger(h.from) && Number.isInteger(h.to) && Array.isArray(h.path) && h.path.length >= 2)
      .map((h) => ({ s0: at(h.from), s1: at(h.to), half: num(h.width, 50) / 2, path: openPath(h.path as Vec[]) })),
    lavas: timed("lava", "open", 36),
    crabs: timed("crabs", "cross", 40),
  };
}

/** Where a point is along the track: like project(), but a car inside a shortcut counts as on
 *  the road, with its progress mapped linearly from the shortcut's start to its end. */
export function locate(t: Track, x: number, y: number, hint = -1): Projection & { shortcut: boolean } {
  const p = project(t, x, y, hint);
  if (t.shortcuts.length === 0 || p.off <= roadHalf(t, p.s)) return { ...p, shortcut: false };
  for (const sc of t.shortcuts) {
    const q = projectOpen(sc.path, x, y);
    if (q.off > sc.half) continue;
    const u = Math.max(0, Math.min(1, q.s / sc.path.length));
    const s = sc.s0 + u * (sc.s1 - sc.s0);
    return { i: indexAt(t, s), s, off: 0, shortcut: true };
  }
  return { ...p, shortcut: false };
}

/** Bridge at centerline distance s (wrapped), if any. */
export function bridgeAt(t: Track, s: number) {
  for (const b of t.bridges) if (s >= b.s0 && s < b.s1) return b;
  return null;
}

/** Half the drivable width at centerline distance s. */
export function roadHalf(t: Track, s: number): number {
  return bridgeAt(t, s)?.half ?? t.def.width / 2;
}

/** Even-odd point-in-polygon test. */
export function inPoly(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ground type under a point: surfaces drawn later win. "road" when on none. */
export function surfaceAt(t: Track, x: number, y: number): "road" | SurfaceKind {
  let kind: "road" | SurfaceKind = "road";
  for (const s of t.def.surfaces) if (inPoly(s.poly, x, y)) kind = s.kind;
  return kind;
}

/** World rect covering the road (with curbs): what "the whole track" means for the camera. */
export function trackBounds(t: Track): { x0: number; y0: number; x1: number; y1: number } {
  const m = t.def.width / 2 + 40;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < t.xs.length; i++) {
    x0 = Math.min(x0, t.xs[i]); y0 = Math.min(y0, t.ys[i]);
    x1 = Math.max(x1, t.xs[i]); y1 = Math.max(y1, t.ys[i]);
  }
  return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
}

/** Distance along the centerline of a centerline point index. */
export function indexDist(t: Track, i: number): number {
  return t.ds[i * SAMPLES_PER_SEGMENT];
}

export interface Projection {
  /** Sample index of the segment start. */
  i: number;
  /** Distance along the centerline. */
  s: number;
  /** Distance from the centerline. */
  off: number;
}

/**
 * Closest point on the centerline. `hint` is the last known segment; searching a window
 * around it keeps this cheap and stops the car "jumping" to a different part of the loop.
 */
export function project(t: Loop, x: number, y: number, hint = -1): Projection {
  const n = t.xs.length;
  const window = hint < 0 ? n : 40;
  const from = hint < 0 ? 0 : hint - window;
  let best = { i: 0, s: 0, off: Infinity };
  for (let w = 0; w < (hint < 0 ? n : window * 2 + 1); w++) {
    const i = (((from + w) % n) + n) % n;
    const j = (i + 1) % n;
    const ax = t.xs[i], ay = t.ys[i];
    const bx = t.xs[j] - ax, by = t.ys[j] - ay;
    const segLen2 = bx * bx + by * by || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / segLen2));
    const px = ax + bx * u, py = ay + by * u;
    const off = Math.hypot(x - px, y - py);
    if (off < best.off) best = { i, s: t.ds[i] + u * Math.sqrt(segLen2), off };
  }
  return best;
}

/** Closest point on an open path (no wrap from the last point back to the first). */
export function projectOpen(t: Loop, x: number, y: number): { s: number; off: number } {
  let best = { s: 0, off: Infinity };
  for (let i = 0; i + 1 < t.xs.length; i++) {
    const ax = t.xs[i], ay = t.ys[i];
    const bx = t.xs[i + 1] - ax, by = t.ys[i + 1] - ay;
    const segLen2 = bx * bx + by * by || 1;
    const u = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / segLen2));
    const off = Math.hypot(x - ax - bx * u, y - ay - by * u);
    if (off < best.off) best = { s: t.ds[i] + u * Math.sqrt(segLen2), off };
  }
  return best;
}

/** Sample index of the segment containing distance s (wraps). Unambiguous, unlike project()
 *  at a figure-8 crossing where two parts of the loop meet. */
export function indexAt(t: Loop, s: number): number {
  const L = t.length;
  s = ((s % L) + L) % L;
  let lo = 0, hi = t.ds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.ds[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Point and heading on the centerline at distance s (wraps around). */
export function pointAt(t: Loop, s: number): { x: number; y: number; a: number } {
  const L = t.length;
  s = ((s % L) + L) % L;
  let lo = 0, hi = t.ds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.ds[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const j = (lo + 1) % t.xs.length;
  const segLen = Math.hypot(t.xs[j] - t.xs[lo], t.ys[j] - t.ys[lo]) || 1;
  const u = (s - t.ds[lo]) / segLen;
  return {
    x: t.xs[lo] + (t.xs[j] - t.xs[lo]) * u,
    y: t.ys[lo] + (t.ys[j] - t.ys[lo]) * u,
    a: Math.atan2(t.ys[j] - t.ys[lo], t.xs[j] - t.xs[lo]),
  };
}
