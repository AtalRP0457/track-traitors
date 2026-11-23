// Room logic, kept free of Cloudflare APIs so it can be unit tested.
// The room is a relay + secret keeper. It never decides race results; the host does.
// Secrets that live only here (PLAN.md section 4): roles, who placed which trap, votes.
// Scores are kept here too, because they depend on those secrets.

import { CAR_COLORS, LAPS, MAX_PLAYERS, SEAT_HOLD_MS } from "../shared/constants";
import { isListName, randomName } from "../shared/names";
import { t as text } from "../shared/strings";
import { parseMsg, PHASES, type AnyMsg, type BotInfo, type Clue, type LobbyMsg, type Phase, type PhaseMsg, type PlayerInfo } from "../shared/protocol";
import {
  CARDS, CARDS_DEALT, DEFAULT_SETTINGS, GLITCH_MS, HARMFUL, isCard, PLACE_POINTS, REACT_GAP_MS, REACTIONS, SCORE, shuffle, tally, traitorCount,
  type Card, type MatchSettings, type Role,
} from "../shared/rules";

export interface RoomIO {
  send(connId: string, msg: AnyMsg): void;
  close(connId: string): void;
  setTimer(key: string, ms: number, fn: () => void): void;
  clearTimer(key: string): void;
  randomId(): string;
  /** Random number in [0, 1) for roles and card deals. Defaults to Math.random. */
  rand?(): number;
  now?(): number;
}

interface Player {
  pid: string;
  seat: string;
  name: string;
  color: string;
  conn: string | null;
  /** Laps completed this race, re-sent to a phone that reconnects mid-race. */
  lap: number;
  role: Role | null;
  /** Cards dealt this race and the ones placed from them. */
  hand: Card[];
  placed: [Card, number, number][];
  glitchUsed: boolean;
  lastReact: number;
}

type ConnRole = { kind: "host" } | { kind: "phone"; pid: string | null };

const STEER = new Set([-1, 0, 1]);

export class RoomCore {
  private host: { seat: string; conn: string | null } | null = null;
  private players = new Map<string, Player>(); // insertion order = join order
  private conns = new Map<string, ConnRole>();
  private phase: Phase = "lobby";
  private laps = LAPS;
  /** Last phase message (minus timing), re-sent to a phone that reconnects. */
  private phaseInfo: Omit<PhaseMsg, "ms"> = { v: 1, t: "phase", phase: "lobby", laps: LAPS };

  // ---------- match secrets ----------
  private settings: MatchSettings = DEFAULT_SETTINGS;
  private bots: BotInfo[] = [];
  private scores = new Map<string, number>();
  private caught = new Set<string>();
  /** This race's traps in the shuffled order the host got them, with owners. */
  private traps: { owner: string; card: Card; x: number; y: number; credited: boolean }[] = [];
  private votes = new Map<string, string>();

  constructor(readonly code: string, private io: RoomIO) {}

  private rand() {
    return this.io.rand ? this.io.rand() : Math.random();
  }
  private now() {
    return this.io.now ? this.io.now() : Date.now();
  }

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
      this.sendProgress();
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
      case "phase":
        this.onPhase(m);
        break;
      case "match":
        this.newMatch(m);
        break;
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
      case "result": {
        if (!Array.isArray(m.places)) return;
        const places = (m.places as { pid: string; ms: number | null }[]).filter((x) => x && typeof x.pid === "string");
        places.forEach((x, i) => this.addScore(x.pid, PLACE_POINTS[i] ?? 0));
        this.toPhones({ v: 1, t: "result", places });
        this.sendScores();
        break;
      }
      case "hit": {
        // A trap went off. Its owner earns points only if they're a traitor and someone else crashed.
        const trap = this.traps[Number(m.trap)];
        const car = String(m.car);
        if (!trap || trap.credited) return;
        trap.credited = true;
        if (HARMFUL.has(trap.card) && car !== trap.owner && this.players.get(trap.owner)?.role === "traitor") {
          this.addScore(trap.owner, SCORE.trapCrash);
          this.sendScores();
        }
        break;
      }
      case "voteend":
        this.endVote();
        break;
    }
  }

  private onPhase(m: { [k: string]: unknown }) {
    const phase = m.phase as Phase;
    if (!PHASES.includes(phase)) return;
    this.phase = phase;
    this.laps = Number(m.laps) || LAPS;
    const num = (x: unknown) => (typeof x === "number" ? x : undefined);
    const msg: PhaseMsg = {
      v: 1, t: "phase", phase, laps: this.laps, ms: num(m.ms), race: num(m.race), races: num(m.races),
      track: typeof m.track === "string" ? m.track : undefined,
      clues: Array.isArray(m.clues) ? (m.clues as Clue[]).slice(0, 24) : undefined,
    };
    this.phaseInfo = { ...msg, ms: undefined } as PhaseMsg;
    this.toPhones(msg);

    switch (phase) {
      case "lobby":
        for (const p of this.players.values()) Object.assign(p, { role: null, hand: [], placed: [], glitchUsed: false });
        this.traps = [];
        break;
      case "draft":
        this.deal(msg.ms ?? 0, msg.track ?? "");
        break;
      case "countdown":
        for (const p of this.players.values()) p.lap = 0;
        this.sendTraps(msg.race ?? 0);
        break;
      case "race":
        for (const p of this.players.values()) p.glitchUsed = false;
        break;
      case "vote":
        this.votes.clear();
        this.sendProgress();
        break;
      case "podium": {
        const traitors = [...this.players.values()].filter((p) => p.role === "traitor").map((p) => p.pid);
        const reveal = { v: 1, t: "reveal", traitors } as const;
        this.toHost(reveal);
        this.toPhones(reveal);
        break;
      }
    }
    this.sendLobby();
  }

  /** New match: secret roles, fresh scores. Bots are always racers. */
  private newMatch(m: { [k: string]: unknown }) {
    const s = (m.settings ?? {}) as Partial<MatchSettings>;
    this.settings = {
      races: s.races === 1 || s.races === 5 ? s.races : 3,
      traitors: s.traitors === 1 || s.traitors === 2 ? s.traitors : 0,
      cards: s.cards === 2 ? 2 : 1,
      bots: !!s.bots,
      track: typeof s.track === "string" ? s.track : "mix",
      mirror: s.mirror === "on" || s.mirror === "mix" ? s.mirror : "off",
    };
    this.bots = (Array.isArray(m.bots) ? (m.bots as BotInfo[]) : [])
      .filter((b) => b && typeof b.pid === "string" && !this.players.has(b.pid))
      .slice(0, MAX_PLAYERS)
      .map((b) => ({ pid: b.pid, name: String(b.name), color: String(b.color) }));

    const humans = [...this.players.values()];
    const n = traitorCount(this.settings.traitors, humans.length, humans.length + this.bots.length);
    const traitors = new Set(shuffle(humans, () => this.rand()).slice(0, n).map((p) => p.pid));
    this.scores.clear();
    this.caught.clear();
    this.traps = [];
    for (const p of humans) {
      Object.assign(p, { role: traitors.has(p.pid) ? "traitor" : "racer", hand: [], placed: [], glitchUsed: false });
      this.scores.set(p.pid, 0);
    }
    for (const b of this.bots) this.scores.set(b.pid, 0);
    for (const p of humans) this.sendRole(p);
    this.toPhones({ v: 1, t: "seats", bots: this.bots });
    this.sendScores();
  }

  private sendRole(p: Player) {
    if (!p.role) return;
    const mates = p.role === "traitor" ? [...this.players.values()].filter((o) => o !== p && o.role === "traitor").map((o) => o.pid) : [];
    this.toPlayer(p.pid, { v: 1, t: "role", role: p.role, mates, caught: this.caught.has(p.pid) });
  }

  /** Every phone gets 3 different random cards for this race. */
  private deal(ms: number, track: string) {
    this.traps = [];
    for (const p of this.players.values()) {
      p.hand = shuffle(CARDS, () => this.rand()).slice(0, CARDS_DEALT);
      p.placed = [];
      this.sendDraft(p, ms, track);
    }
    this.sendProgress();
  }

  private sendDraft(p: Player, ms: number, track: string) {
    this.toPlayer(p.pid, { v: 1, t: "draft", cards: [...p.hand], n: this.settings.cards, ms, track });
    this.toPlayer(p.pid, { v: 1, t: "mytraps", list: [...p.placed] });
  }

  /** Host gets this race's traps shuffled, positions only, never owners. */
  private sendTraps(race: number) {
    const all = [...this.players.values()].flatMap((p) => p.placed.map(([card, x, y]) => ({ owner: p.pid, card, x, y, credited: false })));
    this.traps = shuffle(all, () => this.rand());
    this.toHost({ v: 1, t: "traps", race, list: this.traps.map((t) => [t.card, t.x, t.y]) });
  }

  private endVote() {
    if (this.phase !== "vote") return;
    const caught = tally(this.votes.values());
    const traitor = caught !== null && this.players.get(caught)?.role === "traitor";
    if (caught !== null) {
      if (traitor) {
        this.caught.add(caught);
        this.addScore(caught, SCORE.caught);
        const p = this.players.get(caught);
        if (p) this.sendRole(p); // their phone learns it lost Glitch
      } else this.addScore(caught, SCORE.wronglyAccused);
    }
    // Every traitor still hidden survived this vote.
    for (const p of this.players.values()) if (p.role === "traitor" && !this.caught.has(p.pid)) this.addScore(p.pid, SCORE.survivedVote);
    const msg = { v: 1, t: "voteresult", caught, traitor } as const;
    this.toHost(msg);
    this.toPhones(msg);
    this.votes.clear();
    this.sendScores();
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
        this.io.send(hostConn, { v: 1, t: "in", p: p.pid, s: s as -1 | 0 | 1, b: m.b ? 1 : 0, g: 0, k: Number(m.k) || 0 });
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
        if (hostConn != null && p.pid === this.vip() && (this.phase === "lobby" || this.phase === "podium")) {
          this.io.send(hostConn, { v: 1, t: "start", mode: "traitors" });
        }
        break;
      case "stat": {
        const tt = Number(m.tt);
        if (hostConn != null && tt >= 0 && tt < 5000) this.io.send(hostConn, { v: 1, t: "stat", p: p.pid, tt });
        break;
      }
      case "place": {
        const x = Number(m.x), y = Number(m.y);
        if (this.phase !== "draft" || !isCard(m.card) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        if (p.placed.length >= this.settings.cards) return;
        const i = p.hand.indexOf(m.card);
        if (i < 0) return;
        p.hand.splice(i, 1); // each dealt card can be placed once
        p.placed.push([m.card, Math.round(x), Math.round(y)]);
        this.toPlayer(p.pid, { v: 1, t: "mytraps", list: [...p.placed] });
        this.sendProgress();
        break;
      }
      case "glitch": {
        const target = String(m.target);
        const ok =
          this.phase === "race" && p.role === "traitor" && !this.caught.has(p.pid) && !p.glitchUsed && target !== p.pid &&
          (this.players.has(target) || this.bots.some((b) => b.pid === target));
        this.toPlayer(p.pid, { v: 1, t: "glitchok", ok });
        if (!ok) return;
        p.glitchUsed = true;
        this.toHost({ v: 1, t: "glitch", target });
        this.toPlayer(target, { v: 1, t: "glitched", ms: GLITCH_MS });
        break;
      }
      case "vote": {
        const who = String(m.who ?? "");
        if (this.phase !== "vote" || who === p.pid) return;
        if (who !== "" && (!this.players.has(who) || this.caught.has(who))) return; // bots and caught traitors can't be voted
        this.votes.set(p.pid, who);
        this.sendProgress();
        break;
      }
      case "react": {
        const e = Number(m.e);
        const now = this.now();
        if (!Number.isInteger(e) || e < 0 || e >= REACTIONS.length || now - p.lastReact < REACT_GAP_MS) return;
        p.lastReact = now;
        this.toHost({ v: 1, t: "react", p: p.pid, e });
        break;
      }
    }
  }

  private join(connId: string, role: { kind: "phone"; pid: string | null }, m: { [k: string]: unknown }) {
    if (!this.host) {
      this.io.send(connId, { v: 1, t: "error", code: "no_room", msg: text("error.no_room") });
      return;
    }

    // Reconnect: same pid + matching seat token gets the same car back, plus its secrets.
    const existing = this.players.get(String(m.pid ?? ""));
    if (existing && existing.seat === String(m.seat ?? "")) {
      if (existing.conn && existing.conn !== connId) this.io.close(existing.conn);
      existing.conn = connId;
      role.pid = existing.pid;
      this.io.clearTimer(`seat:${existing.pid}`);
      this.io.send(connId, { v: 1, t: "welcome", pid: existing.pid, seat: existing.seat, name: existing.name, color: existing.color });
      this.io.send(connId, this.phaseInfo as PhaseMsg);
      if (this.phase !== "lobby") {
        this.io.send(connId, { v: 1, t: "seats", bots: this.bots });
        this.sendRole(existing);
        this.io.send(connId, { v: 1, t: "scores", scores: Object.fromEntries(this.scores) });
      }
      if (this.phase === "draft") this.sendDraft(existing, 0, this.phaseInfo.track ?? "");
      if (this.phase === "race") this.io.send(connId, { v: 1, t: "lap", p: existing.pid, lap: existing.lap, laps: this.laps });
      this.sendLobby();
      return;
    }

    // New players can join in the lobby or once a match is over (they play the next one).
    if (this.phase !== "lobby" && this.phase !== "podium") {
      this.io.send(connId, { v: 1, t: "error", code: "started", msg: text("error.started") });
      return;
    }
    if (this.players.size >= MAX_PLAYERS) {
      this.io.send(connId, { v: 1, t: "error", code: "full", msg: text("error.full") });
      return;
    }

    // Names are unique in a room, so votes and glitch targets are never ambiguous.
    const names = new Set([...this.players.values()].map((p) => p.name));
    let name = typeof m.name === "string" && isListName(m.name) ? m.name : randomName();
    for (let i = 0; names.has(name) && i < 200; i++) name = randomName();
    const taken = new Set([...this.players.values()].map((p) => p.color));
    const want = typeof m.color === "string" ? m.color : "";
    const color = CAR_COLORS.includes(want) && !taken.has(want) ? want : CAR_COLORS.find((c) => !taken.has(c))!;

    const p: Player = {
      pid: "p" + this.io.randomId(), seat: this.io.randomId() + this.io.randomId(), name, color, conn: connId, lap: 0,
      role: null, hand: [], placed: [], glitchUsed: false, lastReact: -Infinity,
    };
    this.players.set(p.pid, p);
    role.pid = p.pid;
    this.io.send(connId, { v: 1, t: "welcome", pid: p.pid, seat: p.seat, name, color });
    this.sendLobby();
  }

  // ---------- helpers ----------

  private vip(): string | null {
    return this.players.keys().next().value ?? null;
  }

  private addScore(pid: string, n: number) {
    if (this.scores.has(pid)) this.scores.set(pid, this.scores.get(pid)! + n);
  }

  private sendScores() {
    const msg = { v: 1, t: "scores", scores: Object.fromEntries(this.scores) } as const;
    this.toHost(msg);
    this.toPhones(msg);
  }

  /** Draft: phones that placed all their cards. Vote: phones that voted. */
  private sendProgress() {
    const all = [...this.players.values()];
    let n = 0;
    if (this.phase === "draft") n = all.filter((p) => p.placed.length >= this.settings.cards).length;
    else if (this.phase === "vote") n = all.filter((p) => this.votes.has(p.pid)).length;
    else return;
    this.toHost({ v: 1, t: "progress", n, of: all.length });
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

  private toHost(msg: AnyMsg) {
    if (this.host?.conn) this.io.send(this.host.conn, msg);
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
