// Room logic, kept free of Cloudflare APIs so it can be unit tested.
// The room is a relay + secret keeper. It never decides race results; the host does.

import { CAR_COLORS, DEFAULT_TRACK, LAPS, MAX_PLAYERS, SEAT_HOLD_MS } from "../shared/constants";
import { isListName, randomName } from "../shared/names";
import { t as text } from "../shared/strings";
import { parseMsg, type AnyMsg, type LobbyMsg, type Phase, type PlayerInfo } from "../shared/protocol";

export interface RoomIO {
  send(connId: string, msg: AnyMsg): void;
  close(connId: string): void;
  setTimer(key: string, ms: number, fn: () => void): void;
  clearTimer(key: string): void;
  randomId(): string;
}

interface Player {
  pid: string;
  seat: string;
  name: string;
  color: string;
  conn: string | null;
  /** Laps completed this race, re-sent to a phone that reconnects mid-race. */
  lap: number;
}

type ConnRole = { kind: "host" } | { kind: "phone"; pid: string | null };

const STEER = new Set([-1, 0, 1]);

export class RoomCore {
  private host: { seat: string; conn: string | null } | null = null;
  private players = new Map<string, Player>(); // insertion order = join order
  private conns = new Map<string, ConnRole>();
  private phase: Phase = "lobby";
  private laps = LAPS;

  constructor(readonly code: string, private io: RoomIO) {}

  connect(connId: string, role: "host" | "phone") {
    this.conns.set(connId, role === "host" ? { kind: "host" } : { kind: "phone", pid: null });
  }

  disconnect(connId: string) {
    const role = this.conns.get(connId);
    this.conns.delete(connId);
    if (!role) return;

    if (role.kind === "host") {
      if (this.host?.conn !== connId) return;
      this.host.conn = null;
      this.io.setTimer("host", SEAT_HOLD_MS, () => this.closeRoom());
      this.sendLobby();
      return;
    }

    const p = role.pid ? this.players.get(role.pid) : undefined;
    if (!p || p.conn !== connId) return;
    p.conn = null;
    this.io.setTimer(`seat:${p.pid}`, SEAT_HOLD_MS, () => {
      this.players.delete(p.pid);
      this.sendLobby();
    });
    this.sendLobby();
  }

  message(connId: string, raw: unknown) {
    const role = this.conns.get(connId);
    const m = parseMsg(raw);
    if (!role || !m) return;
    if (role.kind === "host") this.fromHost(connId, m);
    else this.fromPhone(connId, role, m);
  }

  // ---------- host ----------

  private fromHost(connId: string, m: { t: string; [k: string]: unknown }) {
    if (m.t === "hosthello") {
      const seat = String(m.seat ?? "");
      if (!this.host) {
        this.host = { seat, conn: connId };
      } else if (this.host.seat === seat) {
        if (this.host.conn && this.host.conn !== connId) this.io.close(this.host.conn);
        this.host.conn = connId;
        this.io.clearTimer("host");
      } else {
        this.io.send(connId, { v: 1, t: "error", code: "taken", msg: text("error.taken") });
        return;
      }
      this.sendLobby();
      return;
    }
    if (this.host?.conn !== connId) return; // ignore anything from a stale or rejected host

    switch (m.t) {
      case "phase": {
        const phase = m.phase as Phase;
        if (!["lobby", "countdown", "race", "results"].includes(phase)) return;
        this.phase = phase;
        this.laps = Number(m.laps) || LAPS;
        if (phase === "countdown") for (const p of this.players.values()) p.lap = 0;
        const msg = { v: 1, t: "phase", phase, laps: this.laps, ms: typeof m.ms === "number" ? m.ms : undefined } as const;
        this.toPhones(msg);
        this.sendLobby();
        break;
      }
      case "pong":
        this.toPlayer(String(m.p), { v: 1, t: "pong", k: Number(m.k), h: 1 });
        break;
      case "ack":
        this.toPlayer(String(m.p), { v: 1, t: "ack", k: Number(m.k) });
        break;
      case "lap": {
        const p = this.players.get(String(m.p));
        if (!p) return;
        p.lap = Number(m.lap) || 0;
        this.toPlayer(p.pid, { v: 1, t: "lap", p: p.pid, lap: p.lap, laps: this.laps });
        break;
      }
      case "result":
        if (Array.isArray(m.places)) this.toPhones({ v: 1, t: "result", places: m.places as { pid: string; ms: number | null }[] });
        break;
    }
  }

  // ---------- phones ----------

  private fromPhone(connId: string, role: { kind: "phone"; pid: string | null }, m: { t: string; [k: string]: unknown }) {
    if (m.t === "join") return this.join(connId, role, m);

    const p = role.pid ? this.players.get(role.pid) : undefined;
    if (!p || p.conn !== connId) return;
    const hostConn = this.host?.conn;

    switch (m.t) {
      case "in": {
        const s = Number(m.s);
        if (!STEER.has(s) || hostConn == null) return;
        this.io.send(hostConn, { v: 1, t: "in", p: p.pid, s: s as -1 | 0 | 1, b: m.b ? 1 : 0, g: m.g ? 1 : 0, k: Number(m.k) || 0 });
        break;
      }
      case "ping":
        if (hostConn != null) {
          const r = Number(m.r);
          this.io.send(hostConn, { v: 1, t: "ping", p: p.pid, k: Number(m.k), r: r >= 0 && r < 10_000 ? Math.round(r) : undefined });
        }
        else this.io.send(connId, { v: 1, t: "pong", k: Number(m.k), h: 0 });
        break;
      case "startreq":
        if (hostConn != null && p.pid === this.vip() && (this.phase === "lobby" || this.phase === "results")) {
          this.io.send(hostConn, { v: 1, t: "start", mode: "classic", track: DEFAULT_TRACK });
        }
        break;
      case "stat": {
        const tt = Number(m.tt);
        if (hostConn != null && tt >= 0 && tt < 5000) this.io.send(hostConn, { v: 1, t: "stat", p: p.pid, tt });
        break;
      }
    }
  }

  private join(connId: string, role: { kind: "phone"; pid: string | null }, m: { [k: string]: unknown }) {
    if (!this.host) {
      this.io.send(connId, { v: 1, t: "error", code: "no_room", msg: text("error.no_room") });
      return;
    }

    // Reconnect: same pid + matching seat token gets the same car back.
    const existing = this.players.get(String(m.pid ?? ""));
    if (existing && existing.seat === String(m.seat ?? "")) {
      if (existing.conn && existing.conn !== connId) this.io.close(existing.conn);
      existing.conn = connId;
      role.pid = existing.pid;
      this.io.clearTimer(`seat:${existing.pid}`);
      this.io.send(connId, { v: 1, t: "welcome", pid: existing.pid, seat: existing.seat, name: existing.name, color: existing.color });
      this.io.send(connId, { v: 1, t: "phase", phase: this.phase, laps: this.laps });
      if (this.phase === "race") this.io.send(connId, { v: 1, t: "lap", p: existing.pid, lap: existing.lap, laps: this.laps });
      this.sendLobby();
      return;
    }

    // New players can join in the lobby or while results are showing (they race next time).
    if (this.phase !== "lobby" && this.phase !== "results") {
      this.io.send(connId, { v: 1, t: "error", code: "started", msg: text("error.started") });
      return;
    }
    if (this.players.size >= MAX_PLAYERS) {
      this.io.send(connId, { v: 1, t: "error", code: "full", msg: text("error.full") });
      return;
    }

    const name = typeof m.name === "string" && isListName(m.name) ? m.name : randomName();
    const taken = new Set([...this.players.values()].map((p) => p.color));
    const want = typeof m.color === "string" ? m.color : "";
    const color = CAR_COLORS.includes(want) && !taken.has(want) ? want : CAR_COLORS.find((c) => !taken.has(c))!;

    const p: Player = { pid: "p" + this.io.randomId(), seat: this.io.randomId() + this.io.randomId(), name, color, conn: connId, lap: 0 };
    this.players.set(p.pid, p);
    role.pid = p.pid;
    this.io.send(connId, { v: 1, t: "welcome", pid: p.pid, seat: p.seat, name, color });
    this.sendLobby();
  }

  // ---------- helpers ----------

  private vip(): string | null {
    return this.players.keys().next().value ?? null;
  }

  private lobbyMsg(): LobbyMsg {
    const players: PlayerInfo[] = [...this.players.values()].map((p) => ({ pid: p.pid, name: p.name, color: p.color, on: p.conn != null }));
    return { v: 1, t: "lobby", code: this.code, players, vip: this.vip(), phase: this.phase, host: this.host?.conn != null };
  }

  private sendLobby() {
    const msg = this.lobbyMsg();
    if (this.host?.conn) this.io.send(this.host.conn, msg);
    this.toPhones(msg);
  }

  private toPhones(msg: AnyMsg) {
    for (const p of this.players.values()) if (p.conn) this.io.send(p.conn, msg);
  }

  private toPlayer(pid: string, msg: AnyMsg) {
    const c = this.players.get(pid)?.conn;
    if (c) this.io.send(c, msg);
  }

  private closeRoom() {
    for (const p of this.players.values()) {
      this.io.clearTimer(`seat:${p.pid}`);
      if (p.conn) {
        this.io.send(p.conn, { v: 1, t: "error", code: "closed", msg: text("error.closed") });
        this.io.close(p.conn);
      }
    }
    this.players.clear();
    this.host = null;
    this.phase = "lobby";
  }
}
