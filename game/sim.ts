// Race simulation. Fixed 60 Hz step, deterministic for the same inputs, no Phaser.
// The host is the referee: only this code decides positions, laps and finish order.

import { pointAt, project, type Track } from "./track";

export const DT = 1 / 60;

export const TUNING = {
  maxSpeed: 250, // px/s on the road (gas is automatic)
  grassSpeed: 110, // px/s off the road
  accel: 260, // px/s²
  grassDrag: 520, // px/s² when above grass speed
  turnRate: 2.9, // rad/s at full steering
  carRadius: 15,
  /** Progress jumps bigger than this in one tick are ignored, so cutting across the grass earns nothing. */
  maxStepProgress: 40,
};

export interface Car {
  pid: string;
  x: number;
  y: number;
  a: number;
  v: number;
  steer: -1 | 0 | 1;
  /** Unwrapped distance driven along the track. Starts negative (behind the start line). */
  dist: number;
  seg: number;
  lap: number;
  finishMs: number | null;
}

export interface RaceState {
  track: Track;
  laps: number;
  cars: Car[];
  tick: number;
}

export function createRace(track: Track, pids: string[], laps: number): RaceState {
  const cars = pids.map((pid, i) => {
    const back = 50 + Math.floor(i / 2) * 46;
    const side = i % 2 === 0 ? -28 : 28;
    const c = pointAt(track, -back);
    const nx = -Math.sin(c.a), ny = Math.cos(c.a);
    const x = c.x + nx * side, y = c.y + ny * side;
    const p = project(track, x, y);
    return { pid, x, y, a: c.a, v: 0, steer: 0, dist: -back, seg: p.i, lap: 0, finishMs: null } as Car;
  });
  return { track, laps, cars, tick: 0 };
}

export function raceMs(r: RaceState): number {
  return Math.round((r.tick * 1000) / 60);
}

/** Advance one fixed step. Returns pids that completed a lap this tick. */
export function step(r: RaceState): string[] {
  const { track } = r;
  const L = track.length;
  const half = track.def.width / 2;
  const lapped: string[] = [];
  r.tick++;

  for (const c of r.cars) {
    const done = c.finishMs !== null;
    const proj = project(track, c.x, c.y, c.seg);
    const onRoad = proj.off <= half;
    const target = done ? TUNING.maxSpeed * 0.5 : onRoad ? TUNING.maxSpeed : TUNING.grassSpeed;

    if (c.v < target) c.v = Math.min(target, c.v + TUNING.accel * DT);
    else c.v = Math.max(target, c.v - (onRoad ? TUNING.accel : TUNING.grassDrag) * DT);

    // Finished cars steer themselves gently along the road.
    const steer = done ? autoSteer(r, c) : c.steer;
    c.a += steer * TUNING.turnRate * DT * Math.min(1, c.v / 120);
    c.x += Math.cos(c.a) * c.v * DT;
    c.y += Math.sin(c.a) * c.v * DT;

    // Keep cars inside the world.
    const { w, h } = track.def.world;
    if (c.x < 0 || c.x > w || c.y < 0 || c.y > h) {
      c.x = Math.max(0, Math.min(w, c.x));
      c.y = Math.max(0, Math.min(h, c.y));
      c.v *= 0.5;
    }

    // Progress along the track.
    const np = project(track, c.x, c.y, c.seg);
    let d = np.s - proj.s;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    if (Math.abs(d) <= TUNING.maxStepProgress) c.dist += d;
    c.seg = np.i;

    if (!done) {
      const lap = Math.floor(c.dist / L);
      if (lap > c.lap) {
        c.lap = lap;
        lapped.push(c.pid);
        if (lap >= r.laps) c.finishMs = raceMs(r);
      }
    }
  }

  collide(r.cars);
  return lapped;
}

function autoSteer(r: RaceState, c: Car): -1 | 0 | 1 {
  const ahead = pointAt(r.track, (c.dist % r.track.length) + 60);
  let diff = Math.atan2(ahead.y - c.y, ahead.x - c.x) - c.a;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  return diff > 0.1 ? 1 : diff < -0.1 ? -1 : 0;
}

function collide(cars: Car[]) {
  const min = TUNING.carRadius * 2;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const push = (min - d) / 2;
      const ux = dx / d, uy = dy / d;
      a.x -= ux * push; a.y -= uy * push;
      b.x += ux * push; b.y += uy * push;
      a.v *= 0.97; b.v *= 0.97;
    }
  }
}

/** Finishers by time, then everyone else by distance driven. */
export function standings(r: RaceState): { pid: string; ms: number | null }[] {
  return [...r.cars]
    .sort((a, b) => {
      if (a.finishMs !== null && b.finishMs !== null) return a.finishMs - b.finishMs;
      if (a.finishMs !== null) return -1;
      if (b.finishMs !== null) return 1;
      return b.dist - a.dist;
    })
    .map((c) => ({ pid: c.pid, ms: c.finishMs }));
}
