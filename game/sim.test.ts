import { describe, expect, it } from "vitest";
import { createRace, standings, step, type Car, type RaceState } from "./sim";
import { pointAt } from "./track";
import { loadTestTrack } from "./test-tracks";

const track = loadTestTrack();

/** Simple test driver: steer toward a point a bit ahead on the centerline. */
function drive(r: RaceState, c: Car, lookahead = 70) {
  const p = pointAt(r.track, c.dist + lookahead);
  let diff = Math.atan2(p.y - c.y, p.x - c.x) - c.a;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  c.steer = diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0;
}

describe("track", () => {
  it("is a closed loop of sensible length", () => {
    expect(track.length).toBeGreaterThan(3000);
    const a = pointAt(track, 0), b = pointAt(track, track.length);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
  });
});

describe("race sim", () => {
  it("grids every car behind the start line on the road", () => {
    const r = createRace(track, ["a", "b", "c", "d", "e", "f", "g", "h"], 2);
    for (const c of r.cars) expect(c.dist).toBeLessThan(0);
  });

  it("a driven car finishes 2 laps in a reasonable time", () => {
    const r = createRace(track, ["a"], 2);
    let laps = 0;
    for (let i = 0; i < 60 * 120 && r.cars[0].finishMs === null; i++) {
      drive(r, r.cars[0]);
      laps += step(r).length;
    }
    expect(laps).toBe(2);
    const ms = r.cars[0].finishMs!;
    expect(ms).toBeGreaterThan(15_000);
    expect(ms).toBeLessThan(90_000);
  });

  it("is deterministic for the same inputs", () => {
    const run = () => {
      const r = createRace(track, ["a", "b", "c"], 2);
      for (let i = 0; i < 600; i++) {
        r.cars.forEach((c, k) => (k === 2 ? (c.steer = (i % 90 < 45 ? 1 : -1) as 1 | -1) : drive(r, c)));
        step(r);
      }
      return r.cars.map((c) => [c.x, c.y, c.dist]);
    };
    expect(run()).toEqual(run());
  });

  it("driving the wrong way never counts laps", () => {
    const r = createRace(track, ["a"], 2);
    const c = r.cars[0];
    c.a += Math.PI;
    let laps = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const p = pointAt(r.track, c.dist - 70);
      let diff = Math.atan2(p.y - c.y, p.x - c.x) - c.a;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      c.steer = diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0;
      laps += step(r).length;
    }
    expect(laps).toBe(0);
    expect(c.dist).toBeLessThan(0);
  });

  it("teleporting across the infield earns no progress", () => {
    const r = createRace(track, ["a"], 2);
    const c = r.cars[0];
    const far = pointAt(track, track.length / 2);
    c.x = far.x;
    c.y = far.y;
    step(r);
    expect(c.dist).toBeLessThan(0);
  });

  it("a car off the road for 2 s respawns where it left, facing the driving direction", () => {
    const r = createRace(track, ["a"], 2);
    const c = r.cars[0];
    for (let i = 0; i < 200; i++) (drive(r, c), step(r));
    expect(c.offTicks).toBe(0);
    const leftAt = c.dist;
    // Shove it sideways off the road and point it away from the track.
    const p = pointAt(track, c.dist);
    c.x = p.x + Math.cos(p.a + Math.PI / 2) * 200;
    c.y = p.y + Math.sin(p.a + Math.PI / 2) * 200;
    c.a = p.a + Math.PI;
    let back = -1;
    for (let i = 1; i <= 200 && back < 0; i++) {
      step(r);
      if (r.respawned.includes("a")) back = i;
    }
    expect(back).toBeGreaterThanOrEqual(119);
    expect(back).toBeLessThanOrEqual(121);
    const q = pointAt(track, c.dist);
    expect(Math.hypot(c.x - q.x, c.y - q.y)).toBeLessThan(1);
    expect(Math.abs(c.dist - leftAt)).toBeLessThan(60);
    expect(Math.abs(Math.atan2(Math.sin(c.a - q.a), Math.cos(c.a - q.a)))).toBeLessThan(0.05);
    expect(c.v).toBe(0);
  });

  it("coming back onto the road within 2 s cancels the respawn", () => {
    const r = createRace(track, ["a"], 2);
    const c = r.cars[0];
    for (let i = 0; i < 100; i++) (drive(r, c), step(r));
    const p = pointAt(track, c.dist);
    const x = c.x, y = c.y;
    c.x = p.x + Math.cos(p.a + Math.PI / 2) * 200;
    c.y = p.y + Math.sin(p.a + Math.PI / 2) * 200;
    for (let i = 0; i < 100; i++) step(r);
    c.x = x; c.y = y; c.seg = 0;
    step(r);
    expect(c.offTicks).toBe(0);
  });

  it("ranks finishers by time, then the rest by distance", () => {
    const r = createRace(track, ["a", "b", "c"], 2);
    r.cars[0].dist = 100;
    r.cars[1].dist = 500;
    r.cars[2].finishMs = 40_000;
    expect(standings(r).map((s) => s.pid)).toEqual(["c", "b", "a"]);
  });
});
