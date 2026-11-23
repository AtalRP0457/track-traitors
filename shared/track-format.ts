// Track file format (PLAN.md section 2b). Tracks live in public/assets/tracks/<id>.json and are
// only ever loaded from there, never hard-coded. Shared so host, tests and tools agree on it.

export type Vec = [number, number];

/** Ground on top of the road: sand (a bit slower), water (shallow, slow), ash (low grip). */
export type SurfaceKind = "sand" | "water" | "ash";
export const SURFACE_KINDS: SurfaceKind[] = ["sand", "water", "ash"];

export interface Surface {
  kind: SurfaceKind;
  poly: Vec[];
}

/**
 * Track-specific hazards. Shape depends on kind (all indexes are centerline point indexes):
 *   bridge    {from, to, width}                one-car bridge; off it = splash
 *   crossing  {x, y}                           figure-8 crossing (drawing only)
 *   walls     {}                               road edges are walls: nobody can leave the road
 *   shortcut  {from, to, width, path: Vec[]}   narrow side path from centerline[from] to [to] (hollow log)
 *   lava      {at, len, period, open, offset}  crack across the road, open `open` of every `period` ticks
 *   crabs     {at, period, cross, offset}      crab crowd walks across the road in `cross` of every `period` ticks
 */
export interface Hazard {
  kind: string;
  [k: string]: unknown;
}

/** Look of the generated background art. */
export type Theme = "beach" | "harbor" | "lagoon" | "jungle" | "volcano" | "night" | "sandcastle";
export const THEMES: Theme[] = ["beach", "harbor", "lagoon", "jungle", "volcano", "night", "sandcastle"];

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
  /** Art style for the generated background (default "beach"). */
  theme?: Theme;
  /** Difficulty label shown in the host's track picker. */
  difficulty?: "easy" | "medium" | "hard";
  /** Set at load time on Mirror versions (flipped left↔right). Never stored in a file. */
  mirror?: boolean;
}

export const TRACK_DIR = "/assets/tracks";
export const trackUrl = (id: string) => `${TRACK_DIR}/${baseTrackId(id)}.json`;

/** Mirror versions are "<id>~m": same file, flipped left↔right at load time. */
export const MIRROR_SUFFIX = "~m";
export const isMirrorId = (id: string) => id.endsWith(MIRROR_SUFFIX);
export const baseTrackId = (id: string) => (isMirrorId(id) ? id.slice(0, -MIRROR_SUFFIX.length) : id);
export const mirrorId = (id: string) => baseTrackId(id) + MIRROR_SUFFIX;

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

  if (!Array.isArray(t.surfaces) || !t.surfaces.every((s) => s && SURFACE_KINDS.includes(s.kind) && Array.isArray(s.poly) && s.poly.length >= 3 && s.poly.every(isVec))) {
    out.push("surfaces: expected [{kind: sand|water|ash, poly: [[x, y], ≥3]}]");
  }
  if (t.theme !== undefined && !THEMES.includes(t.theme as Theme)) out.push(`theme: expected one of ${THEMES.join(", ")}`);
  if (t.mirror !== undefined) out.push("mirror: set at load time only, never in a file");
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

/** Flip a track left↔right (x → w − x). Driving order stays, so the loop runs the other way round. */
export function mirrorTrack(def: TrackFile): TrackFile {
  const w = def.world.w;
  const fx = ([x, y]: Vec): Vec => [Math.round((w - x) * 10) / 10, y];
  const hazards = def.hazards.map((h) => {
    const out: Hazard = { ...h };
    if (typeof h.x === "number") out.x = w - h.x;
    if (Array.isArray(h.path)) out.path = (h.path as Vec[]).map(fx);
    return out;
  });
  return {
    ...def,
    id: mirrorId(def.id),
    mirror: true,
    centerline: def.centerline.map(fx),
    startGrid: def.startGrid.map(([x, y, a]) => [w - x, y, Math.atan2(Math.sin(Math.PI - a), Math.cos(Math.PI - a))]),
    surfaces: def.surfaces.map((s) => ({ ...s, poly: s.poly.map(fx) })),
    hazards,
    racingLine: def.racingLine.map(fx),
  };
}

/** Fetch a track by id (a Mirror id loads the base file and flips it). Browser and tests. */
export async function fetchTrackFile(id: string, fetchFn: typeof fetch = fetch): Promise<TrackFile> {
  const res = await fetchFn(trackUrl(id));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const def = parseTrack(await res.json());
  return isMirrorId(id) ? mirrorTrack(def) : def;
}
