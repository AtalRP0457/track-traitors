import { describe, expect, it } from "vitest";
import { pointAt, project, SAMPLES_PER_SEGMENT } from "./track";
import { raceClues, snapTrap } from "./traps";
import { loadTestTrack, trackIds } from "./test-tracks";

describe.each(trackIds())("snapTrap on %s", (id) => {
  const t = loadTestTrack(id);
  const inZone = (x: number, y: number) => {
    const i = project(t, x, y).i / SAMPLES_PER_SEGMENT;
    return t.def.trapZones.some(([a, b]) => i >= a - 0.01 && i <= b + 1);
  };

  it("keeps a legal spot as it is", () => {
    const [a] = t.def.trapZones[0];
    const p = pointAt(t, t.ds[(a + 1) * SAMPLES_PER_SEGMENT]);
    expect(snapTrap(t, p.x, p.y)).toEqual({ x: p.x, y: p.y });
  });

  it("pulls any point (even off the map) onto the road inside a trap zone", () => {
    for (const [x, y] of [[-500, -500], [t.def.world.w / 2, t.def.world.h / 2], [t.def.world.w + 300, 40], [10, t.def.world.h - 10]]) {
      const p = snapTrap(t, x, y)!;
      expect(project(t, p.x, p.y).off).toBeLessThanOrEqual(t.def.width / 2);
      expect(inZone(p.x, p.y)).toBe(true);
    }
  });

  it("rejects garbage", () => {
    expect(snapTrap(t, NaN, 3)).toBeNull();
  });
});

describe("clues", () => {
  it("lists crashes, clean racers, glitches and unsprung traps, never owners", () => {
    const c = raceClues(["a", "b"], [{ card: "oil", pid: "a" }, { card: "crab", pid: "a" }, { card: "boost", pid: "b" }], ["b"], 2);
    expect(c).toEqual([{ k: "hits", p: "a", n: 2 }, { k: "clean", p: "b" }, { k: "glitched", p: "b" }, { k: "unsprung", n: 2 }]);
  });
});
