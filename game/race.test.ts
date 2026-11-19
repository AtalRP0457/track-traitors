import { describe, expect, it } from "vitest";
import type { AnyMsg, LobbyMsg } from "../shared/protocol";
import { percentile, RaceHost } from "./race";
import { buildTrack, LAGOON } from "./track";

function setup() {
  const out: AnyMsg[] = [];
  const host = new RaceHost(buildTrack(LAGOON), (m) => out.push(m), () => {});
  const lobby: LobbyMsg = {
    v: 1, t: "lobby", code: "ABCD", vip: "a", phase: "lobby", host: true,
    players: [
      { pid: "a", name: "Zippy Crab", color: "#4DA3FF", on: true },
      { pid: "b", name: "Salty Gull", color: "#FF4D6D", on: true },
    ],
  };
  host.setLobby(lobby);
  return { host, out, lobby };
}

describe("RaceHost", () => {
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
