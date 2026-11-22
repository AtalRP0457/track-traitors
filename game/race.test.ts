import { describe, expect, it } from "vitest";
import type { AnalyticsEvent } from "../shared/analytics";
import type { AnyMsg, LobbyMsg } from "../shared/protocol";
import { percentile, RaceHost } from "./race";
import { loadTestTrack } from "./test-tracks";

function setup() {
  const out: AnyMsg[] = [];
  const events: AnalyticsEvent[] = [];
  const host = new RaceHost(loadTestTrack(), (m) => out.push(m), () => {}, (e) => events.push(e));
  const lobby: LobbyMsg = {
    v: 1, t: "lobby", code: "ABCD", vip: "a", phase: "lobby", host: true,
    players: [
      { pid: "a", name: "Zippy Crab", color: "#4DA3FF", on: true },
      { pid: "b", name: "Salty Gull", color: "#FF4D6D", on: true },
    ],
  };
  host.setLobby(lobby);
  return { host, out, lobby, events };
}

describe("RaceHost", () => {
  it("records poses so the host can replay the last moments in slow motion", () => {
    const { host } = setup();
    host.start();
    host.update(3100);
    for (let i = 0; i < 120; i++) host.update(1000 / 60);
    const t = Math.floor(host.renderTick) - 30;
    const a = host.poseAt("a", t)!, b = host.poseAt("a", t + 1)!, mid = host.poseAt("a", t + 0.5)!;
    expect(mid.x).toBeCloseTo((a.x + b.x) / 2, 6);
    expect(host.poseAt("a", t + 1)).not.toEqual(host.pose("a")); // a recorded pose, not the live one
    expect(host.poseAt("a", -100)).toEqual(host.pose("a")); // too old: falls back to live
  });

  it("logs analytics for joins, disconnects and a whole match", () => {
    const { host, lobby, events } = setup();
    expect(events.filter((e) => e.e === "player_joined")).toHaveLength(2);
    host.start();
    host.update(3100);
    host.setLobby({ ...lobby, phase: "race", players: [lobby.players[0], { ...lobby.players[1], on: false }] });
    host.onStat("a", 40);
    host.onStat("a", 60);
    for (let i = 0; i < 60 * 200 && host.phase === "race"; i++) host.update(1000 / 60);
    const names = events.map((e) => e.e);
    expect(names).toEqual(["player_joined", "player_joined", "match_started", "disconnect", "match_finished", "latency", "fps"]);
    const done = events.find((e) => e.e === "match_finished");
    expect(done).toMatchObject({ track: "sunny-cove", players: 2, disconnects: 1 });
    expect(events.find((e) => e.e === "latency")).toMatchObject({ n: 2 });
    expect(events.find((e) => e.e === "fps")).toMatchObject({ avg: 60 });
  });

  it("goes countdown → race → results and reports places", () => {
    const { host, out } = setup();
    host.start();
    expect(host.phase).toBe("countdown");
    host.update(3100);
    expect(host.phase).toBe("race");
    // Nobody steers: the race still ends at the hard cap.
    for (let i = 0; i < 60 * 200 && host.phase === "race"; i++) host.update(1000 / 60);
    expect(host.phase).toBe("results");
    expect(out.find((m) => m.t === "result")).toBeDefined();
    expect(host.results).toHaveLength(2);
  });

  it("acks each input once, after it is applied and drawn", () => {
    const { host, out } = setup();
    host.start();
    host.update(3100);
    host.onInput("a", 1, 5);
    host.afterRender();
    expect(out.filter((m) => m.t === "ack")).toHaveLength(0); // not applied yet
    host.update(1000 / 60 + 1);
    host.afterRender();
    host.afterRender();
    expect(out.filter((m) => m.t === "ack")).toEqual([{ v: 1, t: "ack", p: "a", k: 5 }]);
    expect(host.race!.cars[0].steer).toBe(1);
  });

  it("a dropped phone's car drives straight", () => {
    const { host, lobby } = setup();
    host.start();
    host.update(3100);
    host.onInput("a", -1, 1);
    host.setLobby({ ...lobby, phase: "race", players: [{ ...lobby.players[0], on: false }, lobby.players[1]] });
    host.update(1000 / 60 + 1);
    expect(host.race!.cars[0].steer).toBe(0);
  });

  it("percentile", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});
