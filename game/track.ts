// Track geometry: a closed centerline + road width. Pure math, no Phaser, so it can run
// anywhere (host, tests, later the server for lap re-simulation).

import type { TrackFile, Vec } from "../shared/track-format";

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

/** Build the runtime track from a (validated) track file. */
export function buildTrack(def: TrackFile): Track {
  const loop = smoothLoop(def.centerline);
  return {
    def,
    ...loop,
    cps: def.checkpoints.map((i) => loop.ds[i * SAMPLES_PER_SEGMENT]),
    line: smoothLoop(def.racingLine),
  };
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
