import { describe, expect, it } from "vitest";
import { mirrorTrack } from "../shared/track-format";
import { createRace, crabSpots, FX, step, TUNING, type Car, type RaceState } from "./sim";
import { loadTestTrack, readTrackFile } from "./test-tracks";
import { buildTrack, locate, pointAt, project, timedOn } from "./track";

function drive(r: RaceState, c: Car, lookahead = 70) {
  const p = pointAt(r.track, c.dist + lookahead);
  let diff = Math.atan2(p.y - c.y, p.x - c.x) - c.a;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  c.steer = diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0;
}

describe("walls (Sandcastle Circuit)", () => {
  const t = loadTestTrack("sandcastle-circuit");
  it("is a walled track", () => expect(t.walls).toBe(true));

  it("a car holding one button never leaves the road and never respawns", () => {
    for (const s of [-1, 1] as const) {
      const r = createRace(t, ["a"], 2);
      const c = r.cars[0];
      for (let i = 0; i < 60 * 20; i++) {
        c.steer = s;
        step(r);
        expect(project(t, c.x, c.y).off).toBeLessThanOrEqual(t.def.width / 2);
        expect(r.respawned).toEqual([]);
      }
    }
  });

  it("a beginner who just holds right still finishes (walls steer them round)", () => {
    const r = createRace(t, ["a"], 2);
    for (let i = 0; i < 60 * 240 && r.cars[0].finishMs === null; i++) {
      r.cars[0].steer = i % 120 < 20 ? 1 : 0; // taps now and then, mostly lets go
      step(r);
    }
    expect(r.cars[0].finishMs).not.toBeNull();
  });
});

describe("hollow log shortcut (Jungle Switchback)", () => {
  const t = loadTestTrack("jungle-switchback");
  const sc = t.shortcuts[0];
  it("exists, one car wide", () => {
    expect(sc).toBeDefined();
    expect(sc.half * 2).toBeLessThan(60);
    expect(sc.s1 - sc.s0).toBeGreaterThan(sc.path.length * 1.5); // it really cuts a corner
  });

  it("counts as road inside the log, with progress mapped along it", () => {
    const mid = Math.floor(sc.path.xs.length / 2);
    const p = locate(t, sc.path.xs[mid], sc.path.ys[mid]);
    expect(p.shortcut).toBe(true);
    expect(p.off).toBe(0);
    expect(p.s).toBeGreaterThan(sc.s0);
    expect(p.s).toBeLessThan(sc.s1);
  });

  it("a car driving through the log keeps its progress and doesn't respawn", () => {
    const r = createRace(t, ["a"], 2);
    const c = r.cars[0];
    const x0 = sc.path.xs[0], y0 = sc.path.ys[0];
    const x1 = sc.path.xs[sc.path.xs.length - 1], y1 = sc.path.ys[sc.path.ys.length - 1];
    Object.assign(c, { x: x0, y: y0, a: Math.atan2(y1 - y0, x1 - x0), v: TUNING.maxSpeed, dist: sc.s0, seg: locate(t, x0, y0).i });
    const before = c.dist;
    for (let i = 0; i < 60 && Math.hypot(c.x - x1, c.y - y1) > 10; i++) {
      c.steer = 0;
      step(r);
      expect(r.respawned).toEqual([]);
    }
    expect(c.dist - before).toBeGreaterThan(sc.s1 - sc.s0 - 40);
  });
});

describe("lava cracks (Volcano Rim)", () => {
  const t = loadTestTrack("volcano-rim");
  it("open and close on a rhythm", () => {
    const h = t.lavas[0];
    expect(t.lavas.length).toBeGreaterThanOrEqual(2);
    const open = Array.from({ length: h.period }, (_, k) => timedOn(h, k)).filter(Boolean).length;
    expect(open).toBe(h.on);
  });

  it("an open crack spins out only the car on it", () => {
    const h = t.lavas[0];
    const r = createRace(t, ["a", "b"], 2);
    const [a, b] = r.cars;
    const p = pointAt(t, h.s), q = pointAt(t, h.s + 300);
    Object.assign(a, { x: p.x, y: p.y, a: p.a, v: 200, dist: h.s, seg: project(t, p.x, p.y).i });
    Object.assign(b, { x: q.x, y: q.y, a: q.a, v: 200, dist: h.s + 300, seg: project(t, q.x, q.y).i });
    while (!timedOn(h, r.tick + 1)) r.tick++;
    step(r);
    expect(r.hazardHits).toEqual([{ kind: "lava", pid: "a" }]);
    expect(a.spin).toBeGreaterThan(0);
    expect(b.spin).toBe(0);
    expect(a.hazImm).toBeGreaterThan(FX.hazardImmune - 2);
  });

  it("ash patches cut grip", () => {
    expect(t.def.surfaces.filter((s) => s.kind === "ash").length).toBeGreaterThan(0);
  });
});

describe("crab crowds (Boardwalk Night Market)", () => {
  const t = loadTestTrack("boardwalk-night-market");
  it("cross the road at set moments, from one side to the other", () => {
    const h = t.crabs[0];
    let start = 0;
    while (crabSpots(t, h, start).length === 0) start++;
    const a = crabSpots(t, h, start)[1], b = crabSpots(t, h, start + h.on - 1)[1];
    const c = pointAt(t, h.s);
    expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThan(t.def.width / 2);
    expect(Math.hypot(b.x - c.x, b.y - c.y)).toBeGreaterThan(t.def.width / 2 - 5);
    expect(crabSpots(t, h, start + h.on)).toEqual([]);
  });

  it("a car that drives into the crowd is stopped briefly", () => {
    const h = t.crabs[0];
    const r = createRace(t, ["a"], 2);
    const c = r.cars[0];
    let k = 0;
    while (crabSpots(t, h, k).length === 0 || Math.abs((crabSpots(t, h, k)[1].x - pointAt(t, h.s).x) + (crabSpots(t, h, k)[1].y - pointAt(t, h.s).y)) > 6) k++;
    r.tick = k - 1;
    const p = pointAt(t, h.s - 20);
    Object.assign(c, { x: p.x, y: p.y, a: p.a, v: 200, dist: h.s - 20, seg: project(t, p.x, p.y).i });
    step(r);
    expect(r.hazardHits).toEqual([{ kind: "crabs", pid: "a" }]);
    expect(c.stun).toBeGreaterThan(0);
  });
});

describe("mirror", () => {
  it("flips the track left↔right and keeps it the same length", () => {
    const def = readTrackFile("coconut-harbor");
    const m = buildTrack(mirrorTrack(def));
    const o = buildTrack(def);
    expect(m.length).toBeCloseTo(o.length, 0);
    expect(m.def.centerline[3][0]).toBeCloseTo(def.world.w - def.centerline[3][0], 1);
    expect(m.bridges.length).toBe(o.bridges.length);
    expect(m.def.mirror).toBe(true);
  });
});
