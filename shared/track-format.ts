// Track file format (PLAN.md section 2b). Tracks live in public/assets/tracks/<id>.json and are
// only ever loaded from there, never hard-coded. Shared so host, tests and tools agree on it.

export type Vec = [number, number];

export interface Surface {
  kind: "sand" | "water";
  poly: Vec[];
}

/** Track-specific hazards (bridge, lava with period, ...). Shape depends on kind; used from Phase 2. */
export interface Hazard {
  kind: string;
  [k: string]: unknown;
}

export interface TrackFile {
  id: string;
  name: string;
  version: number;
  /** World size in px; the background image covers exactly this area. */
  world: { w: number; h: number };
  /** Closed loop of control points in driving order (~40–120). Smoothed in game. Point 0 is the start line. */
  centerline: Vec[];
  /** Road width in px. */
  width: number;
  /** Indexes into centerline, ascending, starting with 0 (the start line). Laps count only in this order. */
  checkpoints: number[];
  /** 8 grid slots: [x, y, angle in radians]. Slot 0 is pole position. */
  startGrid: [number, number, number][];
  surfaces: Surface[];
  hazards: Hazard[];
  /** [fromIndex, toIndex] ranges of centerline where traps may be placed. */
  trapZones: Vec[];
  /** Line bots follow (closed loop). */
  racingLine: Vec[];
  /** Pre-made image paths, relative to public/. */
  background: string;
  minimap: string;
}

export const TRACK_DIR = "/assets/tracks";
export const trackUrl = (id: string) => `${TRACK_DIR}/${id}.json`;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isVec = (x: unknown): x is Vec => Array.isArray(x) && x.length === 2 && x.every(isNum);

/** Check the shape of a parsed track file. Returns a list of problems (empty = valid). */
export function trackProblems(raw: unknown): string[] {
  const out: string[] = [];
  if (!raw || typeof raw !== "object") return ["not an object"];
  const t = raw as Record<string, unknown>;
  const str = (k: string) => typeof t[k] === "string" && (t[k] as string).length > 0 || out.push(`${k}: expected a non-empty string`);
  str("id");
  str("name");
  str("background");
  str("minimap");
  if (!Number.isInteger(t.version) || (t.version as number) < 1) out.push("version: expected an integer ≥ 1");
  const world = t.world as { w?: unknown; h?: unknown } | undefined;
  if (!world || !isNum(world.w) || !isNum(world.h) || world.w <= 0 || world.h <= 0) out.push("world: expected {w, h} > 0");
  if (!isNum(t.width) || t.width <= 0) out.push("width: expected a number > 0");

  const cl = t.centerline;
  const n = Array.isArray(cl) ? cl.length : 0;
  if (!Array.isArray(cl) || !cl.every(isVec)) out.push("centerline: expected [[x, y], ...]");
  else if (n < 40 || n > 120) out.push(`centerline: expected 40–120 points, got ${n}`);

  const cps = t.checkpoints;
  if (!Array.isArray(cps) || cps.length < 2 || !cps.every((i) => Number.isInteger(i) && i >= 0 && i < n)) {
    out.push("checkpoints: expected ≥ 2 centerline indexes");
  } else if (cps[0] !== 0 || cps.some((c, i) => i > 0 && c <= cps[i - 1])) {
    out.push("checkpoints: must start at 0 and be strictly ascending");
  }

  const grid = t.startGrid;
  if (!Array.isArray(grid) || grid.length !== 8 || !grid.every((g) => Array.isArray(g) && g.length === 3 && g.every(isNum))) {
    out.push("startGrid: expected 8 × [x, y, angle]");
  }

  if (!Array.isArray(t.surfaces) || !t.surfaces.every((s) => s && ["sand", "water"].includes(s.kind) && Array.isArray(s.poly) && s.poly.length >= 3 && s.poly.every(isVec))) {
    out.push("surfaces: expected [{kind: sand|water, poly: [[x, y], ≥3]}]");
  }
  if (!Array.isArray(t.hazards) || !t.hazards.every((h) => h && typeof h.kind === "string")) out.push("hazards: expected [{kind, ...}]");

  const zones = t.trapZones;
  if (!Array.isArray(zones) || zones.length === 0 || !zones.every((z) => isVec(z) && Number.isInteger(z[0]) && Number.isInteger(z[1]) && z[0] >= 0 && z[1] < n && z[0] <= z[1])) {
    out.push("trapZones: expected ≥ 1 [fromIndex, toIndex] with from ≤ to");
  }

  if (!Array.isArray(t.racingLine) || t.racingLine.length < 3 || !t.racingLine.every(isVec)) out.push("racingLine: expected [[x, y], ≥3]");
  return out;
}

export function parseTrack(raw: unknown): TrackFile {
  const problems = trackProblems(raw);
  if (problems.length) throw new Error(`Bad track file: ${problems.join("; ")}`);
  return raw as TrackFile;
}
