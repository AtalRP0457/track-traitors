import { describe, expect, it } from "vitest";
import { trackProblems } from "../shared/track-format";
import { botSteer, newBrain } from "./bot";
import { createRace, step, TUNING } from "./sim";
import { publicFileExists, readTrackFile, readTrackRaw, trackIds } from "./test-tracks";
import { buildTrack, indexDist, project } from "./track";

/** PLAN.md 2b: no traps within 2 seconds of the start line (at top speed). */
const NO_TRAP_PX = 2 * TUNING.maxSpeed;

describe.each(trackIds())("track %s", (id) => {
  it("is a valid track file", () => {
    expect(trackProblems(readTrackRaw(id))).toEqual([]);
    expect(readTrackFile(id).id).toBe(id);
  });

  it("has its background and minimap images", () => {
    const f = readTrackFile(id);
    expect(publicFileExists(f.background)).toBe(true);
    expect(publicFileExists(f.minimap)).toBe(true);
  });

  it("keeps trap zones at least 2 s from the start line", () => {
    const t = buildTrack(readTrackFile(id));
    for (const [a, b] of t.def.trapZones) {
      expect(indexDist(t, a)).toBeGreaterThanOrEqual(NO_TRAP_PX);
      expect(t.length - indexDist(t, b)).toBeGreaterThanOrEqual(NO_TRAP_PX);
    }
  });

  it("grids all 8 cars on the road, behind the start line", () => {
    const t = buildTrack(readTrackFile(id));
    const r = createRace(t, ["a", "b", "c", "d", "e", "f", "g", "h"], 2);
    for (const c of r.cars) {
      expect(c.dist).toBeLessThan(0);
      expect(project(t, c.x, c.y).off).toBeLessThan(t.def.width / 2);
    }
  });

  it("is finishable by 8 bots", () => {
    const t = buildTrack(readTrackFile(id));
    const pids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const r = createRace(t, pids, 2);
    const brains = pids.map((_, i) => newBrain(0.4 + i * 0.08));
    for (let i = 0; i < 60 * 180 && r.cars.some((c) => c.finishMs === null); i++) {
      r.cars.forEach((c, k) => (c.steer = botSteer(t, brains[k], c.x, c.y, c.a)));
      step(r);
    }
    expect(r.cars.every((c) => c.finishMs !== null)).toBe(true);
  });

  it("bots change buttons no faster than a human thumb", () => {
    const t = buildTrack(readTrackFile(id));
    const r = createRace(t, ["a"], 2);
    const b = newBrain(0.5);
    let changes = 0, last = 0;
    for (let i = 0; i < 60 * 20; i++) {
      const s = botSteer(t, b, r.cars[0].x, r.cars[0].y, r.cars[0].a);
      if (s !== last) changes++;
      last = r.cars[0].steer = s;
      step(r);
    }
    expect(changes / 20).toBeLessThanOrEqual(10); // ≤ 10 presses/releases per second
  });
});

describe("track validator", () => {
  it("reports missing and bad fields", () => {
    const good = readTrackRaw("sunny-cove") as Record<string, unknown>;
    expect(trackProblems({ ...good, startGrid: [] })).toContain("startGrid: expected 8 × [x, y, angle]");
    expect(trackProblems({ ...good, checkpoints: [3, 1] })).toContain("checkpoints: must start at 0 and be strictly ascending");
    expect(trackProblems({ ...good, centerline: [[0, 0], [1, 1], [2, 2]] }).length).toBeGreaterThan(0);
    expect(trackProblems(null)).toEqual(["not an object"]);
  });
});
