// Trap geometry and vote clues. Pure functions used by the host (validates every trap the room
// sends) and by the phone draft screen (snaps a tap on the minimap to a legal spot).

import type { Clue } from "../shared/protocol";
import { HARMFUL, type Card } from "../shared/rules";
import { pointAt, project, roadHalf, SAMPLES_PER_SEGMENT, type Track } from "./track";

/** Traps sit this far inside the road edge at most, so they're always hittable. */
const EDGE_PX = 18;

/**
 * Snap a point to a legal trap spot: on the road (pulled in from the edge) and inside a trap zone.
 * Points outside every zone go to the nearest zone end. Returns null only for a track without zones.
 */
export function snapTrap(t: Track, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || t.def.trapZones.length === 0) return null;
  const p = project(t, x, y);
  const idx = p.i / SAMPLES_PER_SEGMENT;
  if (!t.def.trapZones.some(([a, b]) => idx >= a && idx <= b + 0.999)) {
    // Outside every zone: move along the road to the closest zone edge.
    let best = { s: 0, d: Infinity };
    for (const [a, b] of t.def.trapZones) {
      // Just inside each end, so the snapped point is clearly in the zone.
      for (const k of [a * SAMPLES_PER_SEGMENT + 2, b * SAMPLES_PER_SEGMENT + SAMPLES_PER_SEGMENT - 2]) {
        const s = t.ds[k % t.ds.length];
        const q = pointAt(t, s);
        const d = Math.hypot(q.x - x, q.y - y);
        if (d < best.d) best = { s, d };
      }
    }
    const q = pointAt(t, best.s);
    return { x: q.x, y: q.y };
  }
  const c = pointAt(t, p.s);
  const max = Math.max(0, roadHalf(t, p.s) - EDGE_PX);
  const dx = x - c.x, dy = y - c.y;
  const off = Math.hypot(dx, dy);
  if (off <= max) return { x, y };
  return { x: c.x + (dx / off) * max, y: c.y + (dy / off) * max };
}

/** Dense points along every trap zone (for drawing them on the phone's minimap). */
export function trapZonePaths(t: Track): [number, number][][] {
  return t.def.trapZones.map(([a, b]) => {
    const pts: [number, number][] = [];
    for (let k = a * SAMPLES_PER_SEGMENT; k <= b * SAMPLES_PER_SEGMENT && k < t.xs.length; k++) pts.push([t.xs[k], t.ys[k]]);
    return pts;
  });
}

/** Public facts about one race for the vote. Nothing here says who placed a trap. */
export function raceClues(
  racers: string[],
  hits: { card: Card; pid: string }[],
  glitched: string[],
  unsprung: number,
): Clue[] {
  const out: Clue[] = [];
  const crashes = new Map<string, number>();
  for (const h of hits) if (HARMFUL.has(h.card)) crashes.set(h.pid, (crashes.get(h.pid) ?? 0) + 1);
  for (const p of racers) {
    const n = crashes.get(p) ?? 0;
    out.push(n > 0 ? { k: "hits", p, n } : { k: "clean", p });
  }
  for (const p of new Set(glitched)) out.push({ k: "glitched", p });
  if (unsprung > 0) out.push({ k: "unsprung", n: unsprung });
  return out;
}
