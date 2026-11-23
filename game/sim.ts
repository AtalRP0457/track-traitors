// Race simulation. Fixed 60 Hz step, deterministic for the same inputs, no Phaser.
// The host is the referee: only this code decides positions, laps, finish order and which
// trap a car touched.

import { HARMFUL, type Card } from "../shared/rules";
import { bridgeAt, indexAt, locate, pointAt, project, roadHalf, surfaceAt, timedOn, timedPhase, type Timed, type Track } from "./track";

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
  /** Off the road this long → respawn where the car left it, facing the right way. */
  respawnTicks: 120,
  /** Off a bridge = in the water: respawn much sooner. */
  splashTicks: 30,
  /** After a respawn the car can't be bumped for this long, so it isn't knocked straight back off. */
  ghostTicks: 60,
  /** Speed multipliers on special ground (on the road). */
  sandSpeed: 0.85,
  waterSpeed: 0.55,
  /** Ash: low grip, so steering turns less (and a touch slower). */
  ashTurn: 0.55,
  ashSpeed: 0.9,
  /** Walls: speed kept per tick while scraping along one. */
  wallScrape: 0.985,
  /** Last place (of the cars still racing) gets slightly higher top speed. */
  catchUp: 1.06,
  /** A car touches a trap when its center is this close. */
  trapRadius: 22,
};

/** Effect lengths in ticks (60 = 1 s). */
export const FX = {
  spin: 48, // oil: one full spin, no steering
  stun: 30, // crab wall / coconut: stopped, no steering
  knockback: 70, // coconut: px pushed back along the track
  slow: 90, // fake boost
  slowCap: 0.45,
  boost: 72,
  boostCap: 1.5,
  air: 42, // ramp: no steering, no bumps
  airCap: 1.15,
  glitch: 120, // reversed steering
  lavaSpin: 48, // open lava crack: spin out
  crabStun: 18, // walked into a crab crowd
  hazardImmune: 90, // after a lava/crab hit, that hazard can't hit the same car again for this long
};

/** Crab crowd: how many crabs walk side by side across the road, and how close counts as a bump. */
export const CRABS = { count: 3, gap: 26, hitPx: 26 };

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
  /** Checkpoints passed in order since the start (checkpoint 0 of lap 0 is the start line). */
  cp: number;
  lap: number;
  finishMs: number | null;
  /** Ticks spent off the road in a row (0 = on the road). */
  offTicks: number;
  /** Progress (dist) at the moment the car left the road: where it respawns. */
  offDist: number;
  /** Ticks left of post-respawn ghosting (no collisions). */
  ghost: number;
  /** Ticks left of each effect. */
  spin: number;
  stun: number;
  slow: number;
  boost: number;
  air: number;
  glitch: number;
  /** Ticks left of immunity to lava cracks and crab crowds after one got this car. */
  hazImm: number;
}

export interface Trap {
  id: number;
  card: Card;
  x: number;
  y: number;
  /** false once a car has set it off (then the host draws it). */
  live: boolean;
}

export interface RaceState {
  track: Track;
  laps: number;
  cars: Car[];
  tick: number;
  traps: Trap[];
  /** Cars put back on the road this tick (for the host's "back on track" effect). */
  respawned: string[];
  /** Traps set off this tick. */
  hits: { trap: number; pid: string }[];
  /** Track hazards (lava, crabs) that got a car this tick: public, shown as a banner. */
  hazardHits: { kind: "lava" | "crabs"; pid: string }[];
}

export function createRace(track: Track, pids: string[], laps: number): RaceState {
  const L = track.length;
  const cars = pids.map((pid, i) => {
    const [x, y, a] = track.def.startGrid[i % track.def.startGrid.length];
    const p = project(track, x, y);
    // Grid slots sit behind the start line, so their distance is negative.
    const dist = p.s > L / 2 ? p.s - L : p.s;
    return { pid, x, y, a, v: 0, steer: 0, dist, seg: p.i, cp: 0, lap: 0, finishMs: null, offTicks: 0, offDist: dist, ghost: 0, spin: 0, stun: 0, slow: 0, boost: 0, air: 0, glitch: 0, hazImm: 0 } as Car;
  });
  return { track, laps, cars, tick: 0, traps: [], respawned: [], hits: [], hazardHits: [] };
}

/** Unwrapped distance of the k-th checkpoint in driving order. */
function cpDist(t: Track, k: number): number {
  const n = t.cps.length;
  return Math.floor(k / n) * t.length + t.cps[k % n];
}

export function raceMs(r: RaceState): number {
  return Math.round((r.tick * 1000) / 60);
}

/** Put a car on the centerline at progress `dist`, pointing along the track. */
function placeOnLine(r: RaceState, c: Car, dist: number) {
  const p = pointAt(r.track, dist);
  c.x = p.x;
  c.y = p.y;
  c.a = p.a;
  c.dist = dist;
  c.seg = indexAt(r.track, dist); // not project(): at a crossing that could pick the other branch
  c.offTicks = 0;
  c.offDist = dist;
}

/** Put a car back on the centerline at progress `dist`, pointing along the track, stopped. */
export function respawn(r: RaceState, c: Car, dist: number) {
  placeOnLine(r, c, dist);
  c.v = 0;
  c.spin = c.air = 0;
  c.ghost = TUNING.ghostTicks;
  r.respawned.push(c.pid);
}

/** Apply a trap's effect to a car. */
export function applyTrap(r: RaceState, c: Car, card: Card) {
  switch (card) {
    case "oil":
      c.spin = FX.spin;
      c.v *= 0.5;
      break;
    case "crab":
      c.v = 0;
      c.stun = FX.stun;
      break;
    case "coconut":
      // Knocked back along the track (progress goes back too, so nothing is gained or lost unfairly).
      placeOnLine(r, c, Math.max(c.dist - FX.knockback, c.dist - 200));
      c.v = 0;
      c.stun = FX.stun;
      c.spin = FX.spin / 2;
      break;
    case "fake":
      c.slow = FX.slow;
      c.v *= 0.5;
      break;
    case "boost":
      c.boost = FX.boost;
      c.v = Math.max(c.v, TUNING.maxSpeed * 1.3);
      break;
    case "ramp":
      c.air = FX.air;
      break;
  }
}

/** Last place among cars still racing (only when 2+ are racing). */
function lastPlace(r: RaceState): Car | null {
  const racing = r.cars.filter((c) => c.finishMs === null);
  if (racing.length < 2) return null;
  return racing.reduce((a, b) => (b.dist < a.dist ? b : a));
}

/** Advance one fixed step. Returns pids that completed a lap this tick. */
export function step(r: RaceState): string[] {
  const { track } = r;
  const L = track.length;
  const lapped: string[] = [];
  r.tick++;
  r.respawned = [];
  r.hits = [];
  r.hazardHits = [];
  const last = lastPlace(r);

  for (const c of r.cars) {
    const done = c.finishMs !== null;
    const proj = locate(track, c.x, c.y, c.seg);
    const half = roadHalf(track, proj.s);
    const onRoad = proj.off <= half || c.air > 0;
    let turn = 1;

    let target = done ? TUNING.maxSpeed * 0.5 : onRoad ? TUNING.maxSpeed : TUNING.grassSpeed;
    if (onRoad && !done) {
      const ground = c.air > 0 || bridgeAt(track, proj.s) || proj.shortcut ? "road" : surfaceAt(track, c.x, c.y);
      if (ground === "sand") target *= TUNING.sandSpeed;
      if (ground === "water") target *= TUNING.waterSpeed;
      if (ground === "ash") (target *= TUNING.ashSpeed), (turn = TUNING.ashTurn);
      if (c === last) target *= TUNING.catchUp;
      if (c.boost > 0) target = TUNING.maxSpeed * FX.boostCap;
      if (c.air > 0) target = Math.max(target, TUNING.maxSpeed * FX.airCap);
    }
    if (c.slow > 0) target = Math.min(target, TUNING.maxSpeed * FX.slowCap);
    if (c.spin > 0) target = Math.min(target, TUNING.maxSpeed * 0.3);
    if (c.stun > 0) target = 0;

    if (c.v < target) c.v = Math.min(target, c.v + TUNING.accel * DT);
    else c.v = Math.max(target, c.v - (onRoad ? TUNING.accel : TUNING.grassDrag) * DT);

    // Finished cars steer themselves gently along the road. Glitch reverses the buttons.
    let steer = done ? autoSteer(r, c) : c.steer;
    if (c.glitch > 0) steer = -steer as -1 | 0 | 1;
    if (c.spin > 0) c.a += (Math.PI * 2) / FX.spin; // one full turn, ends facing the same way
    else if (c.stun === 0 && c.air === 0) c.a += steer * TUNING.turnRate * turn * DT * Math.min(1, c.v / 120);
    c.x += Math.cos(c.a) * c.v * DT;
    c.y += Math.sin(c.a) * c.v * DT;

    // Keep cars inside the world.
    const { w, h } = track.def.world;
    if (c.x < 0 || c.x > w || c.y < 0 || c.y > h) {
      c.x = Math.max(0, Math.min(w, c.x));
      c.y = Math.max(0, Math.min(h, c.y));
      c.v *= 0.5;
    }

    // Walls: slide along the road edge instead of leaving the road.
    if (track.walls) wallClamp(r, c);

    // Progress along the track.
    const np = locate(track, c.x, c.y, c.seg);
    let d = np.s - proj.s;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    // Stepping into or out of a shortcut jumps between its mapped progress and the road's.
    const maxStep = proj.shortcut !== np.shortcut ? Math.max(TUNING.maxStepProgress, ...track.shortcuts.map((sc) => (sc.s1 - sc.s0) / 2)) : TUNING.maxStepProgress;
    if (Math.abs(d) <= maxStep) c.dist += d;
    c.seg = np.i;

    for (const k of ["spin", "stun", "slow", "boost", "air", "glitch", "ghost", "hazImm"] as const) if (c[k] > 0) c[k]--;

    // Off the road: remember where it left; after 2 s put it back there, facing the right way.
    // Off a bridge means in the water, so that's quicker.
    if (c.air === 0 && !np.shortcut && np.off > roadHalf(track, np.s) + TUNING.carRadius) {
      if (c.offTicks === 0) c.offDist = c.dist;
      const limit = bridgeAt(track, ((c.offDist % L) + L) % L) ? TUNING.splashTicks : TUNING.respawnTicks;
      if (++c.offTicks >= limit) respawn(r, c, c.offDist);
    } else c.offTicks = 0;

    // Traps: the first car to touch one sets it off. Airborne cars fly over.
    if (c.air === 0 && !done) {
      for (const t of r.traps) {
        if (!t.live || Math.hypot(t.x - c.x, t.y - c.y) > TUNING.trapRadius + TUNING.carRadius) continue;
        t.live = false;
        applyTrap(r, c, t.card);
        r.hits.push({ trap: t.id, pid: c.pid });
      }
    }

    // Track hazards: open lava cracks and crab crowds. Only the car that touches one is hit.
    if (c.air === 0 && !done && c.hazImm === 0) hazards(r, c, np.s, np.off);

    // Checkpoints only count in order; a lap is done when checkpoint 0 comes round again.
    while (c.dist >= cpDist(track, c.cp)) c.cp++;

    if (!done) {
      const lap = c.cp > 0 ? Math.floor((c.cp - 1) / track.cps.length) : 0;
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

/** Push a car that went past the road edge back onto the road (walled tracks). */
function wallClamp(r: RaceState, c: Car) {
  const p = project(r.track, c.x, c.y, c.seg);
  const max = roadHalf(r.track, p.s) - TUNING.carRadius * 0.6;
  if (p.off <= max) return;
  const q = pointAt(r.track, p.s);
  const k = max / p.off;
  c.x = q.x + (c.x - q.x) * k;
  c.y = q.y + (c.y - q.y) * k;
  c.v *= TUNING.wallScrape;
}

/** Along-track distance from a to b, wrapped to (−L/2, L/2]. */
function along(L: number, a: number, b: number) {
  let d = b - a;
  if (d > L / 2) d -= L;
  if (d <= -L / 2) d += L;
  return d;
}

/** Where each crab of a crowd is right now (empty when the crowd isn't crossing). */
export function crabSpots(t: Track, h: Timed, tick: number): { x: number; y: number }[] {
  const u = timedPhase(h, tick);
  if (u < 0) return [];
  const half = roadHalf(t, h.s) + 20;
  const lateral = -half + u * 2 * half; // walks from one side of the road to the other
  const out: { x: number; y: number }[] = [];
  for (let k = 0; k < CRABS.count; k++) {
    const p = pointAt(t, h.s + (k - (CRABS.count - 1) / 2) * CRABS.gap);
    const nx = -Math.sin(p.a), ny = Math.cos(p.a);
    out.push({ x: p.x + nx * lateral, y: p.y + ny * lateral });
  }
  return out;
}

function hazards(r: RaceState, c: Car, s: number, off: number) {
  const t = r.track;
  for (const h of t.lavas) {
    if (off > roadHalf(t, s) + TUNING.carRadius || Math.abs(along(t.length, h.s, s)) > h.len || !timedOn(h, r.tick)) continue;
    c.spin = FX.lavaSpin;
    c.v *= 0.3;
    c.hazImm = FX.hazardImmune;
    r.hazardHits.push({ kind: "lava", pid: c.pid });
    return;
  }
  for (const h of t.crabs) {
    if (Math.abs(along(t.length, h.s, s)) > CRABS.gap * 2) continue;
    if (!crabSpots(t, h, r.tick).some((p) => Math.hypot(p.x - c.x, p.y - c.y) < CRABS.hitPx + TUNING.carRadius)) continue;
    c.v *= 0.2;
    c.stun = FX.crabStun;
    c.hazImm = FX.hazardImmune;
    r.hazardHits.push({ kind: "crabs", pid: c.pid });
    return;
  }
}

/** A harmful trap's hit counts as a "crash". */
export const isCrash = (card: Card) => HARMFUL.has(card);

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
      if (a.ghost > 0 || b.ghost > 0 || a.air > 0 || b.air > 0) continue;
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
