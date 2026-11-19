import { beforeEach, describe, expect, it } from "vitest";
import type { AnyMsg } from "../shared/protocol";
import { RoomCore, type RoomIO } from "./core";

function setup() {
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
  };
  const room = new RoomCore("ABCD", io);
  const msg = (conn: string, m: object) => room.message(conn, JSON.stringify({ v: 1, ...m }));
  const last = (to: string, t: string) => [...sent].reverse().find((s) => s.to === to && s.msg.t === t)?.msg as any;
  return { room, sent, closed, timers, msg, last };
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

  it("replaces free-text names with a word-list name", () => {
    const a = joinPhone("A", { name: "anything goes" });
    expect(a.name).not.toBe("anything goes");
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
    r.room.connect("A2", "phone");
    r.msg("A2", { t: "join", pid: a.pid, seat: a.seat, name: "x", color: "x" });
    expect(r.last("A2", "welcome")).toMatchObject({ pid: a.pid, color: a.color });
    expect(r.last("A2", "phase").phase).toBe("race");
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
});
