import { describe, expect, it } from "vitest";
import { CAM, clampToWorld, contain, Director, follow, packShot, zoomLimits, type CarPos, type DirectorInput, type Rect, type Shot, type View } from "./camera";

const track: Rect = { x0: 0, y0: 0, x1: 1600, y1: 900 };
const view: View = { w: 1920, h: 1080 };
const car = (pid: string, x: number, y: number, dist: number, a = 0): CarPos => ({ pid, x, y, a, dist, finished: false });

/** World rect the shot shows on screen. */
const visible = (s: Shot, v = view): Rect => ({ x0: s.cx - v.w / 2 / s.zoom, y0: s.cy - v.h / 2 / s.zoom, x1: s.cx + v.w / 2 / s.zoom, y1: s.cy + v.h / 2 / s.zoom });
const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

describe("zoom limits", () => {
  it("never closer than 3 car lengths across the short side, never further than the whole track", () => {
    for (const v of [{ w: 1280, h: 720 }, { w: 1440, h: 900 }, { w: 1920, h: 1080 }, { w: 2560, h: 1080 }]) {
      const { min, max } = zoomLimits(v, track);
      expect(Math.min(v.w, v.h) / max).toBeCloseTo(3 * CAM.carLen);
      const r = visible({ cx: 800, cy: 450, zoom: min }, v);
      expect(r.x1 - r.x0).toBeGreaterThanOrEqual(1600 - 1e-6);
      expect(r.y1 - r.y0).toBeGreaterThanOrEqual(900 - 1e-6);
    }
  });
});

describe("pack shot", () => {
  it("keeps every car in frame with a margin", () => {
    const cars = [car("a", 600, 300, 900), car("b", 500, 350, 800), car("c", 450, 420, 700)];
    const shot = packShot(cars, view, track);
    const r = visible(shot);
    for (const c of cars) expect(inside(pad(r, -CAM.padPx / 2), c.x, c.y)).toBe(true);
  });

  it("pulls the center ahead of the leader", () => {
    const cars = [car("a", 600, 400, 900, 0), car("b", 560, 400, 860, 0)];
    const shot = packShot(cars, view, track);
    expect(shot.cx).toBeGreaterThan(580); // pack middle is 580; leader drives +x
  });

  it("a lone car is not filmed from too close", () => {
    const shot = packShot([car("a", 800, 450, 0)], view, track);
    const r = visible(shot);
    expect(Math.min(r.x1 - r.x0, r.y1 - r.y0)).toBeGreaterThanOrEqual(CAM.packMinCars * CAM.carLen - 1);
  });

  it("never leaves a far-behind car out: zooms out to keep everyone", () => {
    const cars = [car("a", 1400, 200, 3000), car("b", 1350, 250, 2950), car("slow", 150, 800, 100)];
    const r = visible(packShot(cars, view, track));
    for (const c of cars) expect(inside(r, c.x, c.y)).toBe(true);
  });

  it("zooms in more when the cars are close together", () => {
    const near = packShot([car("a", 800, 450, 100), car("b", 760, 450, 60)], view, track);
    const far = packShot([car("a", 1300, 450, 900), car("b", 300, 450, 60)], view, track);
    expect(near.zoom).toBeGreaterThan(far.zoom);
  });
});

describe("contain", () => {
  it("pulls the shot out and over so a car the smoothing lagged behind is back on screen", () => {
    const s = contain({ cx: 400, cy: 400, zoom: 3 }, [{ x: 400, y: 400 }, { x: 1500, y: 850 }], view, { l: 0, r: 300, t: 0, b: 0 }, 40);
    const r = visible(s);
    const freeX1 = r.x1 - 300 / s.zoom;
    for (const [x, y] of [[400, 400], [1500, 850]]) {
      expect(x).toBeGreaterThanOrEqual(r.x0);
      expect(x).toBeLessThanOrEqual(freeX1);
      expect(y).toBeGreaterThanOrEqual(r.y0);
      expect(y).toBeLessThanOrEqual(r.y1);
    }
  });
  it("leaves a shot alone when everyone is already in view", () => {
    const s = { cx: 800, cy: 450, zoom: 1 };
    expect(contain(s, [{ x: 800, y: 450 }], view, { l: 0, r: 0, t: 0, b: 0 }, 40)).toEqual(s);
  });
});

describe("director keeps every racing car in frame", () => {
  it("even when one car is far behind and the smoothing is mid-move", () => {
    const d = new Director();
    const world = { x0: 0, y0: 0, x1: 1600, y1: 900 };
    const ins = { l: 0, r: 300, t: 0, b: 0 };
    const mk = (ax: number): DirectorInput => ({ nowMs: 0, dtMs: 16, phase: "race", countdownLeft: 0,
      cars: [car("a", ax, 200, 3000), car("slow", 150, 800, 100)], finishLine: { x: 0, y: 0 }, finishDist: 9e9, view, track, world, insets: ins });
    d.update(mk(300));
    for (let ax = 300; ax <= 1450; ax += 50) {
      const out = d.update(mk(ax));
      const r = visible(out.shot);
      const freeX1 = r.x1 - ins.r / out.shot.zoom;
      for (const [x, y] of [[ax, 200], [150, 800]]) {
        expect(x).toBeGreaterThanOrEqual(r.x0 - 1e-6);
        expect(x).toBeLessThanOrEqual(freeX1 + 1e-6);
        expect(y).toBeGreaterThanOrEqual(r.y0 - 1e-6);
        expect(y).toBeLessThanOrEqual(r.y1 + 1e-6);
      }
    }
  });
});

describe("world clamp", () => {
  const world: Rect = { x0: 0, y0: 0, x1: 1600, y1: 900 };
  it("never shows past the map edge when zoomed in", () => {
    const s = clampToWorld({ cx: 50, cy: 880, zoom: 3 }, view, world);
    const r = visible(s);
    expect(r.x0).toBeCloseTo(0);
    expect(r.y1).toBeCloseTo(900);
  });
  it("centers an axis the world can't fill", () => {
    const s = clampToWorld({ cx: 50, cy: 50, zoom: 0.5 }, view, world);
    expect(s).toEqual({ cx: 800, cy: 450, zoom: 0.5 });
  });
});

describe("HUD insets", () => {
  it("frames the pack in the free part of the screen, left of the positions tower", () => {
    const d = new Director();
    const cars = [car("a", 1300, 450, 900), car("b", 1100, 450, 800)];
    const out = d.update({ nowMs: 0, dtMs: 16, phase: "race", countdownLeft: 0, cars, finishLine: { x: 0, y: 0 }, finishDist: 9e9,
      view, track, world: { x0: -2000, y0: -2000, x1: 4000, y1: 3000 }, insets: { l: 0, r: 400, t: 0, b: 0 } });
    const r = visible(out.shot);
    const freeRight = r.x1 - 400 / out.shot.zoom; // world x where the tower starts
    for (const c of cars) expect(c.x).toBeLessThan(freeRight);
  });
});

describe("smoothing", () => {
  it("is the same at 30 and 144 fps", () => {
    const from: Shot = { cx: 0, cy: 0, zoom: 1 };
    const to: Shot = { cx: 1000, cy: 500, zoom: 3 };
    let a = from, b = from;
    for (let i = 0; i < 30; i++) a = follow(a, to, 1000 / 30);
    for (let i = 0; i < 144; i++) b = follow(b, to, 1000 / 144);
    expect(a.cx).toBeCloseTo(b.cx, 6);
    expect(a.zoom).toBeCloseTo(b.zoom, 6);
  });
  it("never overshoots", () => {
    const s = follow({ cx: 0, cy: 0, zoom: 1 }, { cx: 100, cy: 0, zoom: 2 }, 10_000);
    expect(s.cx).toBeLessThanOrEqual(100);
    expect(s.zoom).toBeLessThanOrEqual(2);
  });
});

describe("director", () => {
  const base = (over: Partial<DirectorInput>): DirectorInput => ({
    nowMs: 0, dtMs: 16, phase: "race", countdownLeft: 0,
    cars: [car("a", 600, 300, 900), car("b", 500, 350, 800)],
    finishLine: { x: 200, y: 450 }, finishDist: 7000, view, track, world: { x0: 0, y0: 0, x1: 4000, y1: 3000 }, ...over,
  });

  it("opens the countdown on a wide shot, then frames the grid", () => {
    const d = new Director();
    expect(d.update(base({ phase: "countdown", countdownLeft: 3000 })).kind).toBe("intro");
    expect(d.update(base({ phase: "countdown", countdownLeft: 1000 })).kind).toBe("grid");
  });

  it("trap cut: live zoom toward the crash for 1.5 s (never slow motion), at most one per 5 s", () => {
    const d = new Director();
    d.update(base({ nowMs: 0 }));
    expect(d.trapHit(300, 300, 1000)).toBe(true);
    const during = d.update(base({ nowMs: 1500 }));
    expect(during.kind).toBe("cut");
    expect(during).not.toHaveProperty("slowmo");
    expect(d.trapHit(900, 300, 3000)).toBe(false); // too soon
    expect(d.update(base({ nowMs: 2600 })).kind).toBe("pack");
    expect(d.trapHit(900, 300, 6100)).toBe(true);
  });

  it("goes to the finish line on the last stretch and holds after the winner crosses", () => {
    const d = new Director();
    const near = [car("a", 250, 450, 6700), car("b", 600, 450, 6000)];
    expect(d.update(base({ nowMs: 0, cars: near })).kind).toBe("finish");
    const won = [{ ...near[0], dist: 7010, finished: true }, near[1]];
    expect(d.update(base({ nowMs: 100, cars: won })).kind).toBe("finish");
    expect(d.update(base({ nowMs: 100 + CAM.finishHoldMs + 10, cars: won })).kind).toBe("pack");
  });
});

function pad(r: Rect, px: number): Rect {
  return { x0: r.x0 - px, y0: r.y0 - px, x1: r.x1 + px, y1: r.y1 + px };
}
