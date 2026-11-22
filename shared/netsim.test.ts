import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetSim, simFromQuery } from "./netsim";

describe("NetSim", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes straight through when off", () => {
    const got: number[] = [];
    const sim = new NetSim();
    sim.out(() => got.push(1), true);
    sim.in((x: number) => got.push(x))(2);
    expect(got).toEqual([1, 2]);
  });

  it("delays by lag and keeps order even with jitter", () => {
    let r = 0.99;
    const sim = new NetSim({ lag: 100, jitter: 50, loss: 0 }, () => r);
    const got: number[] = [];
    sim.out(() => got.push(1)); // due ≈ 149.5 ms
    r = 0;
    sim.out(() => got.push(2)); // would be 100 ms, but must not overtake #1
    vi.advanceTimersByTime(99);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(got).toEqual([1, 2]);
  });

  it("drops only droppable messages", () => {
    const sim = new NetSim({ lag: 0, jitter: 0, loss: 100 }, () => 0.5);
    const got: string[] = [];
    expect(sim.out(() => got.push("in"), true)).toBe(false);
    sim.out(() => got.push("join"), false);
    vi.runAllTimers();
    expect(got).toEqual(["join"]);
    expect(sim.dropped).toBe(1);
  });

  it("reads and clamps URL params", () => {
    expect(simFromQuery(new URLSearchParams("lag=80&jitter=20&loss=500"))).toEqual({ lag: 80, jitter: 20, loss: 100 });
    expect(simFromQuery(new URLSearchParams("lag=abc"))).toEqual({ lag: 0, jitter: 0, loss: 0 });
  });
});
