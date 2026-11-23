import { describe, expect, it } from "vitest";
import type { AnalyticsEvent } from "../shared/analytics";
import type { AnyMsg, LobbyMsg } from "../shared/protocol";
import { DRAFT_MS, RESULTS_MS, REVEAL_MS, ROLE_MS, VOTE_MS } from "../shared/rules";
import { COUNTDOWN_MS } from "../shared/constants";
import { percentile, RaceHost } from "./race";
import { FX } from "./sim";
import { pointAt } from "./track";
import { loadTestTrack } from "./test-tracks";

const FRAME = 1000 / 60;

function setup(players = 2) {
  const out: AnyMsg[] = [];
  const events: AnalyticsEvent[] = [];
  const host = new RaceHost(loadTestTrack(), (m) => out.push(m), () => {}, (e) => events.push(e));
  const all = [
    { pid: "a", name: "Zippy Crab", color: "#4DA3FF", on: true },
    { pid: "b", name: "Salty Gull", color: "#FF4D6D", on: true },
    { pid: "c", name: "Lucky Seal", color: "#3DDC84", on: true },
  ];
  const lobby: LobbyMsg = { v: 1, t: "lobby", code: "ABCD", vip: "a", phase: "lobby", host: true, players: all.slice(0, players) };
  host.setLobby(lobby);
  return { host, out, lobby, events };
}

/** Lobby → role → draft → countdown → race (one race). */
function toRace(host: RaceHost) {
  if (host.phase === "lobby" || host.phase === "podium") host.start();
  if (host.phase === "role") host.update(ROLE_MS + 1);
  expect(host.phase).toBe("draft");
  host.update(DRAFT_MS + 1);
  expect(host.phase).toBe("countdown");
  host.update(COUNTDOWN_MS + 100);
  expect(host.phase).toBe("race");
}

function runRace(host: RaceHost) {
  for (let i = 0; i < 60 * 200 && host.phase === "race"; i++) host.update(FRAME);
  expect(host.phase).toBe("results");
}

describe("RaceHost match flow", () => {
  it("plays role → (draft → race → results) × 3 with votes after races 2 and 3, then the podium", () => {
    const { host, out } = setup();
    host.settings = { ...host.settings, races: 3, bots: false };
    host.start();
    expect(host.phase).toBe("role");
    expect(out.find((m) => m.t === "match")).toMatchObject({ settings: { races: 3 }, bots: [] });

    const phases: string[] = [];
    const seen = () => phases.push(host.phase);
    for (let race = 1; race <= 3; race++) {
      toRace(host);
      seen();
      runRace(host);
      seen();
      host.update(RESULTS_MS + 1);
      seen();
      if (host.phase === "vote") {
        expect(host.clues.length).toBeGreaterThan(0);
        host.update(VOTE_MS + 1); // time's up: host closes the vote
        expect(out.at(-1)).toEqual({ v: 1, t: "voteend" });
        host.onVoteResult("b", true);
        expect(host.phase).toBe("reveal");
        expect(host.knownTraitors.has("b")).toBe(true);
        host.update(REVEAL_MS + 1);
        seen();
      }
    }
    expect(phases).toEqual(["race", "results", "draft", "race", "results", "vote", "draft", "race", "results", "vote", "podium"]);
    expect(out.filter((m) => m.t === "result")).toHaveLength(3);
  });

  it("ends the draft and the vote early once every phone is done", () => {
    const { host } = setup();
    host.start();
    host.update(ROLE_MS + 1);
    expect(host.phase).toBe("draft");
    host.onProgress(2, 2);
    host.update(FRAME);
    expect(host.phase).toBe("countdown");
  });

  it("tells phones which race of how many, and the track", () => {
    const { host, out } = setup();
    host.settings = { ...host.settings, races: 5 };
    host.start();
    host.update(ROLE_MS + 1);
    expect(out.filter((m) => m.t === "phase").at(-1)).toMatchObject({ phase: "draft", race: 1, races: 5, track: "sunny-cove" });
  });

  it("a room that never answers a closed vote doesn't stall the match", () => {
    const { host } = setup();
    host.settings = { ...host.settings, races: 1 };
    toRace(host);
    runRace(host);
    host.update(RESULTS_MS + 1);
    expect(host.phase).toBe("vote");
    for (let i = 0; i < 60 * 30 && host.phase === "vote"; i++) host.update(VOTE_MS);
    expect(host.phase).toBe("reveal");
    expect(host.voteResult).toEqual({ caught: null, traitor: false });
  });
});

describe("bots", () => {
  it("fill empty seats up to 3 racers, only when switched on", () => {
    const one = setup(1);
    one.host.settings = { ...one.host.settings, bots: true };
    toRace(one.host);
    expect(one.host.bots).toHaveLength(2);
    expect(one.host.race!.cars).toHaveLength(3);
    expect(new Set(one.host.roster.map((p) => p.color)).size).toBe(3);

    const off = setup(1);
    off.host.settings = { ...off.host.settings, bots: false };
    toRace(off.host);
    expect(off.host.race!.cars).toHaveLength(1);

    const full = setup(3);
    toRace(full.host);
    expect(full.host.bots).toHaveLength(0);
  });

  it("bots and dropped phones drive themselves round the track", () => {
    const { host, lobby } = setup(1);
    toRace(host);
    host.setLobby({ ...lobby, phase: "race", players: [{ ...lobby.players[0], on: false }] });
    for (let i = 0; i < 60 * 15; i++) host.update(FRAME);
    for (const c of host.race!.cars) expect(c.dist).toBeGreaterThan(1500);
  });
});

describe("traps and glitch on the host", () => {
  it("snaps traps onto the road, keeps them hidden until a car touches one, then reports the hit", () => {
    const { host, out } = setup(1);
    host.settings = { ...host.settings, bots: false };
    let cut: [number, number] | null = null;
    host.onTrapCut = (x, y) => (cut = [x, y]);
    toRace(host);
    const t = host.race!.track;
    // A bad entry (dropped) and a trap on the centerline inside sunny-cove's first trap zone.
    const s = t.ds[9 * 8] + 100;
    const p = pointAt(t, s);
    host.onTraps(host.raceNo, [["nope", 1, 1], ["oil", p.x, p.y]]);
    expect(host.race!.traps).toHaveLength(1);
    expect(host.race!.traps.every((x) => x.live)).toBe(true);
    // Drive the car onto it.
    const car = host.race!.cars[0];
    for (let i = 0; i < 60 * 20 && host.race!.traps[0].live; i++) {
      const q = pointAt(t, car.dist + 70);
      let diff = Math.atan2(q.y - car.y, q.x - car.x) - car.a;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      host.onInput("a", diff > 0.05 ? 1 : diff < -0.05 ? -1 : 0, i);
      host.update(FRAME);
    }
    expect(host.race!.traps[0].live).toBe(false);
    expect(out.find((m) => m.t === "hit")).toEqual({ v: 1, t: "hit", trap: 1, car: "a" }); // index in the room's list
    expect(host.banner?.key).toBe("hit.oil");
    expect(cut).not.toBeNull();
  });

  it("ignores traps for another race", () => {
    const { host } = setup(1);
    toRace(host);
    host.onTraps(host.raceNo + 1, [["oil", 100, 100]]);
    expect(host.race!.traps).toHaveLength(0);
  });

  it("glitch reverses a car's steering for 2 s and flashes static", () => {
    const { host } = setup();
    toRace(host);
    host.onGlitch("b");
    const car = host.race!.cars.find((c) => c.pid === "b")!;
    expect(car.glitch).toBe(FX.glitch);
    expect(host.glitchFlash).toBeGreaterThan(host.race!.tick);
    expect(host.banner?.key).toBe("banner.glitch");
  });
});

describe("RaceHost basics", () => {
  it("logs analytics for joins, disconnects and a race", () => {
    const { host, lobby, events } = setup();
    host.settings = { ...host.settings, bots: false };
    expect(events.filter((e) => e.e === "player_joined")).toHaveLength(2);
    toRace(host);
    host.setLobby({ ...lobby, phase: "race", players: [lobby.players[0], { ...lobby.players[1], on: false }] });
    host.onStat("a", 40);
    host.onStat("a", 60);
    runRace(host);
    const names = events.map((e) => e.e);
    expect(names).toEqual(["player_joined", "player_joined", "match_started", "disconnect", "match_finished", "latency", "fps"]);
    expect(events.find((e) => e.e === "match_finished")).toMatchObject({ track: "sunny-cove", players: 2, disconnects: 1 });
    expect(events.find((e) => e.e === "latency")).toMatchObject({ n: 2 });
    expect(events.find((e) => e.e === "fps")).toMatchObject({ avg: 60 });
  });

  it("acks each input once, after it is applied and drawn", () => {
    const { host, out } = setup();
    toRace(host);
    host.onInput("a", 1, 5);
    host.afterRender();
    expect(out.filter((m) => m.t === "ack")).toHaveLength(0); // not applied yet
    host.update(FRAME + 1);
    host.afterRender();
    host.afterRender();
    expect(out.filter((m) => m.t === "ack")).toEqual([{ v: 1, t: "ack", p: "a", k: 5 }]);
    expect(host.race!.cars[0].steer).toBe(1);
  });

  it("percentile", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
});
