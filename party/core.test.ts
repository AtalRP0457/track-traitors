import { beforeEach, describe, expect, it } from "vitest";
import type { AnyMsg } from "../shared/protocol";
import { RATE, RoomCore, type RoomIO } from "./core";

function setup(rand: () => number = Math.random) {
  const sent: { to: string; msg: AnyMsg }[] = [];
  const closed: string[] = [];
  const timers = new Map<string, () => void>();
  let n = 0;
  const io: RoomIO = {
    send: (to, msg) => sent.push({ to, msg }),
    close: (id) => closed.push(id),
    setTimer: (k, _ms, fn) => timers.set(k, fn),
    clearTimer: (k) => timers.delete(k),
    randomId: () => String(++n).padStart(5, "0"),
    rand,
    now: () => clock.t,
  };
  const clock = { t: 0 };
  const room = new RoomCore("ABCD", io);
  const msg = (conn: string, m: object) => room.message(conn, JSON.stringify({ v: 1, ...m }));
  const last = (to: string, t: string) => [...sent].reverse().find((s) => s.to === to && s.msg.t === t)?.msg as any;
  return { room, sent, closed, timers, msg, last, clock };
}

describe("RoomCore", () => {
  let r: ReturnType<typeof setup>;

  beforeEach(() => {
    r = setup();
    r.room.connect("H", "host");
    r.msg("H", { t: "hosthello", seat: "hs" });
  });

  function joinPhone(conn: string, extra: object = {}) {
    r.room.connect(conn, "phone");
    r.msg(conn, { t: "join", pid: "", seat: "", name: "Zippy Crab", color: "#4DA3FF", ...extra });
    return r.last(conn, "welcome");
  }

  it("rejects a phone when no host owns the room", () => {
    const s = setup();
    s.room.connect("P", "phone");
    s.msg("P", { t: "join", pid: "", seat: "", name: "Zippy Crab", color: "#4DA3FF" });
    expect(s.last("P", "error").code).toBe("no_room");
  });

  it("rejects a second host with another token", () => {
    r.room.connect("H2", "host");
    r.msg("H2", { t: "hosthello", seat: "other" });
    expect(r.last("H2", "error").code).toBe("taken");
  });

  it("joins, gives unique colors, never leaks seat tokens in the lobby", () => {
    const a = joinPhone("A");
    const b = joinPhone("B");
    expect(a.color).toBe("#4DA3FF");
    expect(b.color).not.toBe("#4DA3FF");
    const lobby = r.last("H", "lobby");
    expect(lobby.players).toHaveLength(2);
    expect(lobby.vip).toBe(a.pid);
    expect(JSON.stringify(lobby)).not.toContain(a.seat);
  });

  it("keeps names unique in a room", () => {
    const a = joinPhone("A", { name: "Zippy Crab" });
    const b = joinPhone("B", { name: "Zippy Crab" });
    expect(a.name).toBe("Zippy Crab");
    expect(b.name).not.toBe("Zippy Crab");
  });

  it("replaces free-text names with a word-list name", () => {
    const a = joinPhone("A", { name: "anything goes" });
    expect(a.name).not.toBe("anything goes");
  });

  it("My screen: host learns the viewer count; snapshots go only to phones that watch", () => {
    joinPhone("A");
    joinPhone("B");
    expect(r.last("H", "viewers")).toBeUndefined(); // nobody watching: nothing sent
    r.msg("A", { t: "view", on: true });
    expect(r.last("H", "viewers")).toEqual({ v: 1, t: "viewers", n: 1 });
    r.msg("H", { t: "snap", k: 1, c: [1, 2, 3], ids: ["x"] });
    expect(r.last("A", "snap")).toMatchObject({ c: [1, 2, 3], ids: ["x"] });
    expect(r.last("B", "snap")).toBeUndefined();
    r.room.disconnect("A");
    expect(r.last("H", "viewers")).toEqual({ v: 1, t: "viewers", n: 0 });
  });

  it("a trap hit makes only that car's phone play its bonk animation", () => {
    const a = joinPhone("A");
    joinPhone("B");
    r.msg("H", { t: "bonk", p: a.pid, kind: "lava" });
    expect(r.last("A", "bonk")).toEqual({ v: 1, t: "bonk", kind: "lava" });
    expect(r.last("B", "bonk")).toBeUndefined();
  });

  it("rate-limits a flooding phone, then disconnects it; normal play is never limited", () => {
    const a = joinPhone("A");
    const inputs = () => r.sent.filter((x) => x.to === "H" && x.msg.t === "in").length;
    // Normal: 20 steering changes a second for 5 s all get through.
    for (let i = 0; i < 100; i++) {
      r.clock.t += 50;
      r.msg("A", { t: "in", s: i % 2 ? 1 : -1, b: 0, g: 0, k: i });
    }
    expect(inputs()).toBe(100);
    // Flood: 1000 messages at once.
    for (let i = 0; i < 1000; i++) r.msg("A", { t: "in", s: 1, b: 0, g: 0, k: 1000 + i });
    expect(inputs()).toBeLessThan(100 + RATE.burst + 1);
    expect(r.closed).toContain("A");
    void a;
  });

  it("forwards input to the host with the sender pid", () => {
    const a = joinPhone("A");
    r.msg("A", { t: "in", s: -1, b: 0, g: 0, k: 7 });
    expect(r.last("H", "in")).toEqual({ v: 1, t: "in", p: a.pid, s: -1, b: 0, g: 0, k: 7 });
    r.msg("A", { t: "in", s: 5, b: 0, g: 0, k: 8 });
    expect(r.last("H", "in").k).toBe(7); // invalid steer dropped
  });

  it("routes ping to host and pong back to the right phone", () => {
    const a = joinPhone("A");
    r.msg("A", { t: "ping", k: 3 });
    expect(r.last("H", "ping")).toMatchObject({ p: a.pid, k: 3 });
    r.msg("A", { t: "ping", k: 4, r: 42.4 });
    expect(r.last("H", "ping")).toMatchObject({ p: a.pid, k: 4, r: 42 });
    r.msg("A", { t: "ping", k: 5, r: -1 });
    expect(r.last("H", "ping")!.r).toBeUndefined();
    r.msg("H", { t: "pong", k: 3, p: a.pid });
    expect(r.last("A", "pong")).toEqual({ v: 1, t: "pong", k: 3, h: 1 });
  });

  it("only the VIP can ask to start", () => {
    joinPhone("A");
    joinPhone("B");
    r.msg("B", { t: "startreq" });
    expect(r.last("H", "start")).toBeUndefined();
    r.msg("A", { t: "startreq" });
    expect(r.last("H", "start")).toBeDefined();
  });

  it("holds a dropped seat and gives the same car back with the token", () => {
    const a = joinPhone("A");
    r.room.disconnect("A");
    expect(r.last("H", "lobby").players[0].on).toBe(false);
    expect(r.timers.has(`seat:${a.pid}`)).toBe(true);

    r.msg("H", { t: "phase", phase: "race", laps: 2 });
    r.msg("H", { t: "lap", p: a.pid, lap: 1, laps: 2 });
    r.room.connect("A2", "phone");
    r.msg("A2", { t: "join", pid: a.pid, seat: a.seat, name: "x", color: "x" });
    expect(r.last("A2", "welcome")).toMatchObject({ pid: a.pid, color: a.color });
    expect(r.last("A2", "phase").phase).toBe("race");
    expect(r.last("A2", "lap").lap).toBe(1);
    expect(r.timers.has(`seat:${a.pid}`)).toBe(false);
  });

  it("frees the seat after the hold expires", () => {
    const a = joinPhone("A");
    r.room.disconnect("A");
    r.timers.get(`seat:${a.pid}`)!();
    expect(r.last("H", "lobby").players).toHaveLength(0);
  });

  it("does not let a wrong token take a car, and blocks new joins mid-race", () => {
    const a = joinPhone("A");
    r.msg("H", { t: "phase", phase: "race", laps: 2 });
    r.room.connect("X", "phone");
    r.msg("X", { t: "join", pid: a.pid, seat: "guess", name: "x", color: "x" });
    expect(r.last("X", "welcome")).toBeUndefined();
    expect(r.last("X", "error").code).toBe("started");
  });

  it("lets the host rejoin with its token, closes the room after the hold", () => {
    joinPhone("A");
    r.room.disconnect("H");
    expect(r.last("A", "lobby").host).toBe(false);
    r.room.connect("H2", "host");
    r.msg("H2", { t: "hosthello", seat: "hs" });
    expect(r.last("A", "lobby").host).toBe(true);

    r.room.disconnect("H2");
    r.timers.get("host")!();
    expect(r.last("A", "error").code).toBe("closed");
  });

  it("sends lap and ack only to the matching phone", () => {
    const a = joinPhone("A");
    joinPhone("B");
    r.msg("H", { t: "lap", p: a.pid, lap: 2, laps: 2 });
    r.msg("H", { t: "ack", p: a.pid, k: 4 });
    expect(r.last("A", "lap").lap).toBe(2);
    expect(r.last("B", "lap")).toBeUndefined();
    expect(r.last("B", "ack")).toBeUndefined();
  });

  // ---------- Phase 2: secrets, draft, glitch, votes, scores ----------

  function match(n: number, settings: object = {}, bots: object[] = []) {
    const ps = Array.from({ length: n }, (_, i) => joinPhone(String.fromCharCode(65 + i)));
    r.msg("H", { t: "match", settings: { races: 3, traitors: 0, cards: 1, bots: true, track: "mix", ...settings }, bots });
    r.msg("H", { t: "phase", phase: "role", laps: 2, ms: 5000, race: 0, races: 3 });
    const roles = ps.map((p, i) => ({ ...p, conn: String.fromCharCode(65 + i), role: r.last(String.fromCharCode(65 + i), "role") }));
    return roles;
  }

  it("gives each phone only its own role; traitors see each other; nothing secret goes to the host", () => {
    const ps = match(6);
    const traitors = ps.filter((p) => p.role.role === "traitor");
    expect(traitors).toHaveLength(2); // 6 players → 2
    for (const tr of traitors) expect(tr.role.mates).toEqual(traitors.filter((x) => x !== tr).map((x) => x.pid));
    for (const p of ps.filter((p) => p.role.role === "racer")) expect(p.role.mates).toEqual([]);
    expect(r.sent.filter((s) => s.to === "H").some((s) => s.msg.t === "role")).toBe(false);
    // Every role message went to exactly one phone.
    expect(r.sent.filter((s) => s.msg.t === "role").map((s) => s.to).sort()).toEqual(["A", "B", "C", "D", "E", "F"]);
  });

  it("deals 3 different cards, lets a phone place only dealt cards, and sends the host shuffled traps without owners", () => {
    const ps = match(3);
    r.msg("H", { t: "phase", phase: "draft", laps: 2, ms: 20000, race: 1, races: 3, track: "sunny-cove" });
    const d = r.last("A", "draft");
    expect(new Set(d.cards).size).toBe(3);
    expect(d).toMatchObject({ n: 1, track: "sunny-cove" });
    const notDealt = ["oil", "crab", "coconut", "fake", "boost", "ramp"].find((c) => !d.cards.includes(c));
    r.msg("A", { t: "place", card: notDealt, x: 10, y: 10 });
    expect(r.last("A", "mytraps")?.list ?? []).toEqual([]);
    r.msg("A", { t: "place", card: d.cards[0], x: 400.4, y: 100 });
    expect(r.last("A", "mytraps").list).toEqual([[d.cards[0], 400, 100]]);
    r.msg("A", { t: "place", card: d.cards[1], x: 1, y: 1 }); // only 1 card per player
    expect(r.last("A", "mytraps").list).toHaveLength(1);
    expect(r.last("H", "progress")).toMatchObject({ n: 1, of: 3 });
    r.msg("B", { t: "place", card: r.last("B", "draft").cards[0], x: 500, y: 200 });

    r.msg("H", { t: "phase", phase: "countdown", laps: 2, ms: 3000, race: 1, races: 3 });
    const traps = r.last("H", "traps");
    expect(traps.race).toBe(1);
    expect(traps.list).toHaveLength(2);
    expect(JSON.stringify(traps)).not.toContain(ps[0].pid);
    expect(JSON.stringify(traps)).not.toContain(ps[1].pid);
    // Phones never get the trap list.
    expect(r.sent.some((s) => s.to !== "H" && s.msg.t === "traps")).toBe(false);
  });

  it("scores race places, and trap crashes only for a traitor's harmful trap on someone else", () => {
    // rand = 0 → the first phone is the traitor and gets the first cards.
    r = setup(() => 0);
    r.room.connect("H", "host");
    r.msg("H", { t: "hosthello", seat: "hs" });
    const ps = match(3);
    const traitor = ps.find((p) => p.role.role === "traitor")!;
    r.msg("H", { t: "phase", phase: "draft", laps: 2, ms: 20000, race: 1, races: 3, track: "sunny-cove" });
    const hand = r.last(traitor.conn, "draft").cards as string[];
    const harmful = hand.find((c) => ["oil", "crab", "coconut", "fake"].includes(c))!;
    r.msg(traitor.conn, { t: "place", card: harmful, x: 1, y: 1 });
    r.msg("H", { t: "phase", phase: "countdown", laps: 2, ms: 3000, race: 1, races: 3 });
    const victim = ps.find((p) => p !== traitor)!;
    r.msg("H", { t: "hit", trap: 0, car: victim.pid });
    r.msg("H", { t: "hit", trap: 0, car: victim.pid }); // counted once
    expect(r.last("H", "scores").scores[traitor.pid]).toBe(3);

    r.msg("H", { t: "result", places: [{ pid: victim.pid, ms: 1 }, { pid: traitor.pid, ms: 2 }, { pid: "bot1", ms: null }] });
    const sc = r.last("A", "scores").scores;
    expect(sc[victim.pid]).toBe(10);
    expect(sc[traitor.pid]).toBe(3 + 8);
  });

  it("glitch: only a traitor, once per race, never says who to the host", () => {
    const ps = match(3);
    const traitor = ps.find((p) => p.role.role === "traitor")!;
    const racer = ps.find((p) => p.role.role === "racer")!;
    r.msg("H", { t: "phase", phase: "race", laps: 2, race: 1, races: 3 });
    r.msg(racer.conn, { t: "glitch", target: traitor.pid });
    expect(r.last("H", "glitch")).toBeUndefined();
    expect(r.last(racer.conn, "glitchok").ok).toBe(false);
    r.msg(traitor.conn, { t: "glitch", target: racer.pid });
    expect(r.last("H", "glitch")).toEqual({ v: 1, t: "glitch", target: racer.pid });
    expect(r.last(racer.conn, "glitched").ms).toBe(2000);
    r.msg(traitor.conn, { t: "glitch", target: racer.pid });
    expect(r.sent.filter((s) => s.to === "H" && s.msg.t === "glitch")).toHaveLength(1);
    // New race: it's back.
    r.msg("H", { t: "phase", phase: "race", laps: 2, race: 2, races: 3 });
    r.msg(traitor.conn, { t: "glitch", target: racer.pid });
    expect(r.sent.filter((s) => s.to === "H" && s.msg.t === "glitch")).toHaveLength(2);
  });

  it("vote: catching the traitor costs them 5 and stops Glitch; surviving pays 5; a wrong accusation pays the innocent 2", () => {
    const ps = match(4);
    const traitor = ps.find((p) => p.role.role === "traitor")!;
    const racers = ps.filter((p) => p !== traitor);

    // Vote 1: majority on an innocent racer.
    r.msg("H", { t: "phase", phase: "vote", laps: 2, ms: 20000, race: 2, races: 3, clues: [] });
    r.msg(traitor.conn, { t: "vote", who: racers[0].pid });
    r.msg(racers[1].conn, { t: "vote", who: racers[0].pid });
    r.msg(racers[0].conn, { t: "vote", who: racers[0].pid }); // can't vote for yourself: ignored
    r.msg(racers[2].conn, { t: "vote", who: "" });
    expect(r.last("H", "progress")).toMatchObject({ n: 3, of: 4 });
    expect(r.sent.some((s) => s.to === "H" && s.msg.t === "vote")).toBe(false); // votes stay secret
    r.msg("H", { t: "voteend" });
    expect(r.last("H", "voteresult")).toEqual({ v: 1, t: "voteresult", caught: racers[0].pid, traitor: false });
    let sc = r.last("H", "scores").scores;
    expect(sc[racers[0].pid]).toBe(2);
    expect(sc[traitor.pid]).toBe(5);

    // Vote 2: tie → nobody caught, traitor survives again.
    r.msg("H", { t: "phase", phase: "vote", laps: 2, ms: 20000, race: 3, races: 3, clues: [] });
    r.msg(racers[0].conn, { t: "vote", who: traitor.pid });
    r.msg(racers[1].conn, { t: "vote", who: racers[2].pid });
    r.msg("H", { t: "voteend" });
    expect(r.last("H", "voteresult").caught).toBeNull();
    expect(r.last("H", "scores").scores[traitor.pid]).toBe(10);

    // Vote 3: caught.
    r.msg("H", { t: "phase", phase: "vote", laps: 2, ms: 20000, race: 3, races: 3, clues: [] });
    for (const p of racers) r.msg(p.conn, { t: "vote", who: traitor.pid });
    r.msg("H", { t: "voteend" });
    expect(r.last("H", "voteresult")).toMatchObject({ caught: traitor.pid, traitor: true });
    sc = r.last("H", "scores").scores;
    expect(sc[traitor.pid]).toBe(5);
    expect(r.last(traitor.conn, "role").caught).toBe(true);
    r.msg("H", { t: "phase", phase: "race", laps: 2, race: 4, races: 5 });
    r.msg(traitor.conn, { t: "glitch", target: racers[0].pid });
    expect(r.last(traitor.conn, "glitchok").ok).toBe(false);
  });

  it("reveals the traitors to everyone at the podium, and allows a new match from there", () => {
    const ps = match(3);
    const traitor = ps.find((p) => p.role.role === "traitor")!;
    r.msg("H", { t: "phase", phase: "podium", laps: 2, race: 3, races: 3 });
    expect(r.last("H", "reveal").traitors).toEqual([traitor.pid]);
    expect(r.last("B", "reveal").traitors).toEqual([traitor.pid]);
    r.msg("A", { t: "startreq" });
    expect(r.last("H", "start")).toEqual({ v: 1, t: "start", mode: "traitors" });
  });

  it("re-sends role, draft and own traps to a phone that reconnects", () => {
    const ps = match(3);
    r.msg("H", { t: "phase", phase: "draft", laps: 2, ms: 20000, race: 1, races: 3, track: "sunny-cove" });
    const card = r.last("A", "draft").cards[0];
    r.msg("A", { t: "place", card, x: 5, y: 6 });
    r.room.disconnect("A");
    r.room.connect("A2", "phone");
    r.msg("A2", { t: "join", pid: ps[0].pid, seat: ps[0].seat, name: "x", color: "x" });
    expect(r.last("A2", "role")).toEqual(ps[0].role);
    expect(r.last("A2", "draft").cards).toHaveLength(2); // the placed card is used up
    expect(r.last("A2", "mytraps").list).toEqual([[card, 5, 6]]);
    expect(r.last("A2", "phase")).toMatchObject({ phase: "draft", race: 1, track: "sunny-cove" });
  });

  it("bots are racers: never get a role, can't be voted, but can be glitched and score", () => {
    const ps = match(1, { traitors: 1 }, [{ pid: "bot1", name: "Bot", color: "#fff" }]);
    expect(ps[0].role.role).toBe("traitor"); // a lone phone can be the traitor (solo testing)
    r.msg("H", { t: "phase", phase: "race", laps: 2, race: 1, races: 3 });
    r.msg("A", { t: "glitch", target: "bot1" });
    expect(r.last("H", "glitch").target).toBe("bot1");
    r.msg("H", { t: "phase", phase: "vote", laps: 2, ms: 1, race: 1, races: 1, clues: [] });
    r.msg("A", { t: "vote", who: "bot1" });
    expect(r.last("H", "progress")).toMatchObject({ n: 0 });
  });

  it("reactions: fixed set, rate limited, forwarded to the host with who sent them", () => {
    const a = joinPhone("A");
    r.msg("A", { t: "react", e: 2 });
    r.msg("A", { t: "react", e: 3 }); // too soon
    r.msg("A", { t: "react", e: 99 });
    expect(r.sent.filter((s) => s.msg.t === "react")).toEqual([{ to: "H", msg: { v: 1, t: "react", p: a.pid, e: 2 } }]);
    r.clock.t += 500;
    r.msg("A", { t: "react", e: 3 });
    expect(r.sent.filter((s) => s.msg.t === "react")).toHaveLength(2);
  });
});
