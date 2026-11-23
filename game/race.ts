// Host-side game flow for a Traitors match (PLAN.md section 2):
//   lobby → role → (draft → countdown → race → results → [vote → reveal]) × races → podium
// Owns the simulation and the clock, applies the latest phone inputs each tick, drives bots,
// detects trap hits, and tells the room what happened. It never learns roles, trap owners or votes.

import type { AnalyticsEvent } from "../shared/analytics";
import { COUNTDOWN_MS, LAPS, CAR_COLORS } from "../shared/constants";
import { randomName } from "../shared/names";
import type { AnyMsg, BotInfo, Clue, LobbyMsg, Phase, PlayerInfo } from "../shared/protocol";
import {
  DEFAULT_SETTINGS, DRAFT_MS, HARMFUL, isCard, matchTracks, MIN_RACERS, PLACE_POINTS, REVEAL_MS, RESULTS_MS, ROLE_MS, VOTE_MS, voteAfter,
  type Card, type MatchSettings,
} from "../shared/rules";
import type { StringKey } from "../shared/strings";
import { botSteer, newBrain, type BotBrain } from "./bot";
import type { CameraInfo } from "./hud";
import { createRace, DT, FX, standings, step, type RaceState } from "./sim";
import type { Track } from "./track";
import { raceClues, snapTrap } from "./traps";

/** After the first car finishes, the others get this long before the race ends. */
const FINISH_GRACE_MS = 15_000;
/** Hard cap so a race never stalls. */
const MAX_RACE_MS = 180_000;
const MAX_STEPS_PER_FRAME = 5;
const STAT_WINDOW = 200;
/** If the room never answers a closed vote, move on after this long. */
const VOTE_RESULT_WAIT_MS = 3000;
/** Static flash on the TV when someone is glitched. */
const GLITCH_FLASH_TICKS = 24;

export interface Pose { x: number; y: number; a: number }
export interface Reaction { id: number; e: number; pid: string; atMs: number }

export class RaceHost {
  phase: Phase = "lobby";
  /** Phones in the room (from the lobby message). */
  players: PlayerInfo[] = [];
  /** Bot seats for the current match (host-side cars). */
  bots: PlayerInfo[] = [];
  race: RaceState | null = null;
  results: { pid: string; ms: number | null }[] = [];
  /** ms left in the current timed phase (role, draft, countdown, results, vote, reveal). */
  phaseLeft = 0;
  settings: MatchSettings = { ...DEFAULT_SETTINGS };
  /** Settings frozen at match start. */
  match: MatchSettings = { ...DEFAULT_SETTINGS };
  raceNo = 0;
  /** Running match totals from the room. */
  scores: Record<string, number> = {};
  /** Draft / vote progress from the room. */
  progress = { n: 0, of: 0 };
  clues: Clue[] = [];
  voteResult: { caught: string | null; traitor: boolean } | null = null;
  /** Publicly known traitors: caught in a vote, or all of them at the podium. */
  knownTraitors = new Set<string>();
  revealed = false;
  reactions: Reaction[] = [];
  /** Tick until which the TV shows glitch static. */
  glitchFlash = 0;
  /** Matches finished on this host device (from storage; the ads rule and the beginner track use it). */
  matchesPlayed = 0;
  /** Called when a match reaches the podium. */
  onMatchDone?: () => void;
  /** Track id for each race of the current match. */
  trackPlan: string[] = [];

  /** Latest input per player; applied on the next physics tick. */
  private inputs = new Map<string, { s: -1 | 0 | 1; k: number }>();
  private applied = new Map<string, number>();
  private acked = new Map<string, number>();
  private prev = new Map<string, Pose>();
  private acc = 0;
  private firstFinishTick: number | null = null;
  /** Bot brains for bot seats and for phones that dropped mid-race. */
  private brains = new Map<string, BotBrain>();
  private pendingTraps: { race: number; list: unknown[] } | null = null;
  private raceLog = { hits: [] as { card: Card; pid: string }[], glitched: [] as string[] };
  private voteEndAt: number | null = null;
  private loading: string | null = null;
  private nextReact = 1;

  /** touch → TV samples reported by phones (ms). */
  stats: number[] = [];
  lastStat = new Map<string, number>();
  /** Host frames per second, measured over the last second. */
  fps = 0;
  private fpsFrames = 0;
  private fpsMs = 0;
  /** Filled by the scene each frame for the HUD. */
  camera: CameraInfo = { kind: "wide", layout: null };
  /** Latest event banner for the big screen (top center). Shown for BANNER_TICKS. */
  banner: { key: StringKey; vars: Record<string, string | number>; tick: number } | null = null;
  /** Dev hook: runs after every physics tick (fake-phone bots). */
  afterTick?: () => void;
  /** Called when a harmful trap goes off at (x, y): the scene cuts the camera there. */
  onTrapCut?: (x: number, y: number) => void;
  /** A lava crack or crab crowd got a car (for sound). */
  onHazard?: (kind: "lava" | "crabs") => void;
  /** Loads a track by id (fetch + build). Without it every race uses the current track. */
  loadTrack?: (id: string) => Promise<Track>;
  /** Per-match numbers for analytics. */
  private stat = { stats: [] as number[], fps: [] as number[], disconnects: 0 };

  constructor(
    public track: Track | null,
    private send: (m: AnyMsg) => void,
    private onChange: () => void,
    private log: (e: AnalyticsEvent) => void = () => {},
  ) {}

  /** Everyone with a car: phones, then bots. */
  get roster(): PlayerInfo[] {
    return [...this.players, ...this.bots];
  }

  /** Car number shown on the roof, the positions tower and the phone (1-based seat order). */
  carNumber(pid: string): number {
    const i = this.roster.findIndex((p) => p.pid === pid);
    return i < 0 ? 0 : i + 1;
  }

  name(pid: string): string {
    return this.roster.find((p) => p.pid === pid)?.name ?? "?";
  }

  // ---------- messages from the room ----------

  setLobby(m: LobbyMsg) {
    const before = new Map(this.players.map((p) => [p.pid, p.on]));
    for (const p of m.players) {
      if (!before.has(p.pid)) this.log({ e: "player_joined", pid: p.pid, players: m.players.length });
      else if (before.get(p.pid) && !p.on) {
        this.log({ e: "disconnect", who: "phone", pid: p.pid, phase: this.phase });
        if (this.phase === "countdown" || this.phase === "race") this.stat.disconnects++;
      }
    }
    this.players = m.players;
    for (const p of m.players) if (!p.on) this.inputs.set(p.pid, { s: 0, k: this.inputs.get(p.pid)?.k ?? 0 });
    if (this.race) {
      const keep = new Set([...m.players.map((p) => p.pid), ...this.bots.map((b) => b.pid)]);
      this.race.cars = this.race.cars.filter((c) => keep.has(c.pid)); // seat expired: car leaves
    }
    // A reloaded host page comes back with the room still mid-match; reset the room to match.
    if (m.phase !== this.phase) this.sendPhase();
    this.onChange();
  }

  onInput(p: string, s: -1 | 0 | 1, k: number) {
    this.inputs.set(p, { s, k });
  }

  onStat(p: string, tt: number) {
    this.stats.push(tt);
    if (this.stats.length > STAT_WINDOW) this.stats.shift();
    if (this.phase === "race") this.stat.stats.push(tt);
    this.lastStat.set(p, tt);
  }

  onProgress(n: number, of: number) {
    this.progress = { n, of };
    this.onChange();
  }

  onScores(scores: Record<string, number>) {
    this.scores = scores;
    this.onChange();
  }

  /** This race's traps (positions only). The host checks every one: snapped onto a legal spot. */
  onTraps(race: number, list: unknown[]) {
    if (race !== this.raceNo) return;
    if (!this.race) {
      this.pendingTraps = { race, list };
      return;
    }
    const t = this.race.track;
    this.race.traps = [];
    list.forEach((item, id) => {
      if (!Array.isArray(item) || !isCard(item[0])) return;
      const p = snapTrap(t, Number(item[1]), Number(item[2]));
      if (p) this.race!.traps.push({ id, card: item[0], x: p.x, y: p.y, live: true });
    });
    this.onChange();
  }

  onGlitch(target: string) {
    const r = this.race;
    const car = r?.cars.find((c) => c.pid === target);
    if (this.phase !== "race" || !r || !car || car.finishMs !== null) return;
    car.glitch = FX.glitch;
    this.raceLog.glitched.push(target);
    this.glitchFlash = r.tick + GLITCH_FLASH_TICKS;
    this.banner = { key: "banner.glitch", vars: { name: this.name(target) }, tick: r.tick };
  }

  onVoteResult(caught: string | null, traitor: boolean) {
    if (this.phase !== "vote") return;
    this.voteResult = { caught, traitor };
    if (caught && traitor) this.knownTraitors.add(caught);
    this.log({ e: "vote_result", caught: caught && traitor ? 1 : 0, traitors: this.knownTraitors.size });
    this.setPhase("reveal", REVEAL_MS);
  }

  onReveal(traitors: string[]) {
    for (const p of traitors) this.knownTraitors.add(p);
    this.revealed = true;
    this.onChange();
  }

  onReact(pid: string, e: number, nowMs: number) {
    this.reactions.push({ id: this.nextReact++, e, pid, atMs: nowMs });
    if (this.reactions.length > 30) this.reactions.shift();
  }

  // ---------- match flow ----------

  /** Start a new match (from the lobby or the podium). */
  start() {
    if (this.phase !== "lobby" && this.phase !== "podium") return;
    if (this.players.length === 0 || !this.track) return;
    this.match = { ...this.settings };
    this.bots = this.makeBots();
    this.raceNo = 0;
    this.scores = {};
    this.knownTraitors.clear();
    this.revealed = false;
    this.voteResult = null;
    this.results = [];
    this.race = null;
    this.stat = { stats: [], fps: [], disconnects: 0 };
    this.trackPlan = matchTracks(this.match, this.match.races, this.matchesPlayed === 0);
    const bots: BotInfo[] = this.bots.map(({ pid, name, color }) => ({ pid, name, color }));
    this.send({ v: 1, t: "match", settings: this.match, bots });
    this.log({ e: "match_started", track: this.trackPlan[0], players: this.roster.length });
    this.setPhase("role", ROLE_MS);
  }

  backToLobby() {
    this.race = null;
    this.bots = [];
    this.setPhase("lobby");
  }

  /** Bots fill empty seats up to 3 racers. Names from the word list, colors nobody has. */
  private makeBots(): PlayerInfo[] {
    if (!this.match.bots) return [];
    const n = Math.max(0, MIN_RACERS - this.players.length);
    const usedNames = new Set(this.players.map((p) => p.name));
    const freeColors = CAR_COLORS.filter((c) => !this.players.some((p) => p.color === c));
    const out: PlayerInfo[] = [];
    for (let i = 0; i < n; i++) {
      let name = randomName();
      while (usedNames.has(name)) name = randomName();
      usedNames.add(name);
      out.push({ pid: `bot${i + 1}`, name, color: freeColors[i % freeColors.length], on: true });
    }
    return out;
  }

  private nextRace() {
    this.raceNo++;
    this.race = null;
    this.pendingTraps = null;
    this.voteResult = null;
    this.clues = [];
    this.progress = { n: 0, of: this.players.length };
    const id = this.trackPlan[this.raceNo - 1] ?? this.trackPlan[0];
    if (this.loadTrack && this.track?.def.id !== id) {
      this.loading = id;
      this.loadTrack(id)
        .then((t) => {
          if (this.loading === id) (this.track = t), (this.loading = null);
        })
        .catch(() => (this.loading = null)); // keep the current track
    }
    this.setPhase("draft", DRAFT_MS);
  }

  private startCountdown() {
    const t = this.track!;
    this.race = createRace(t, this.roster.map((p) => p.pid), LAPS);
    this.prev.clear();
    this.applied.clear();
    this.acked.clear();
    this.acc = 0;
    this.firstFinishTick = null;
    this.results = [];
    this.banner = null;
    this.glitchFlash = 0;
    this.raceLog = { hits: [], glitched: [] };
    this.brains.clear();
    for (const p of this.roster) this.brains.set(p.pid, newBrain(this.bots.includes(p) ? 0.55 + Math.random() * 0.3 : 0.6));
    if (this.pendingTraps) this.onTraps(this.pendingTraps.race, this.pendingTraps.list);
    this.pendingTraps = null;
    this.setPhase("countdown", COUNTDOWN_MS);
  }

  /** Called when a timed phase runs out (or everyone is done early). */
  private advance() {
    switch (this.phase) {
      case "role":
        return this.nextRace();
      case "draft":
        if (this.loading) return; // wait for the next track to load
        return this.startCountdown();
      case "countdown":
        return this.setPhase("race");
      case "results":
        if (voteAfter(this.raceNo, this.match.races)) {
          this.clues = this.makeClues();
          this.voteResult = null;
          this.voteEndAt = null;
          this.progress = { n: 0, of: this.players.length };
          return this.setPhase("vote", VOTE_MS);
        }
        return this.afterRace();
      case "vote":
        if (this.voteEndAt === null) {
          this.voteEndAt = 0;
          this.send({ v: 1, t: "voteend" });
        } else if (this.voteEndAt <= -VOTE_RESULT_WAIT_MS) {
          this.voteResult = { caught: null, traitor: false }; // room never answered
          this.setPhase("reveal", REVEAL_MS);
        }
        return;
      case "reveal":
        return this.afterRace();
    }
  }

  private afterRace() {
    if (this.raceNo < this.match.races) return this.nextRace();
    this.matchesPlayed++;
    this.onMatchDone?.();
    this.setPhase("podium");
  }

  private makeClues(): Clue[] {
    const racers = this.players.map((p) => p.pid);
    const unsprung = this.race?.traps.filter((t) => t.live).length ?? 0;
    return raceClues(racers, this.raceLog.hits.filter((h) => racers.includes(h.pid)), this.raceLog.glitched, unsprung);
  }

  // ---------- per frame ----------

  /** Called every rendered frame with the frame time in ms. Runs fixed 60 Hz physics steps. */
  update(deltaMs: number) {
    this.countFps(deltaMs);
    if (this.phase !== "race") {
      if (["role", "draft", "countdown", "results", "vote", "reveal"].includes(this.phase)) {
        this.phaseLeft -= deltaMs;
        if (this.voteEndAt !== null && this.phase === "vote") this.voteEndAt -= deltaMs;
        const allDone = (this.phase === "draft" || this.phase === "vote") && this.progress.of > 0 && this.progress.n >= this.progress.of;
        if (this.phaseLeft <= 0 || allDone) this.advance();
      }
      return;
    }
    if (!this.race) return;

    this.acc += Math.min(deltaMs / 1000, DT * MAX_STEPS_PER_FRAME);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.tick();
      if (this.phase !== "race") return;
    }
  }

  /** Back-compat for the HUD and camera: time left in the countdown. */
  get countdownLeft(): number {
    return this.phase === "countdown" ? this.phaseLeft : 0;
  }

  private tick() {
    const r = this.race!;
    const offline = new Set(this.players.filter((p) => !p.on).map((p) => p.pid));
    for (const c of r.cars) {
      this.prev.set(c.pid, { x: c.x, y: c.y, a: c.a });
      const brain = this.brains.get(c.pid);
      // Bots, and phones that dropped mid-race, are driven by the bot brain so nobody gets stuck.
      if (brain && (offline.has(c.pid) || this.bots.some((b) => b.pid === c.pid))) {
        c.steer = botSteer(r.track, brain, c.x, c.y, c.a);
        continue;
      }
      const inp = this.inputs.get(c.pid);
      if (inp) {
        c.steer = inp.s;
        this.applied.set(c.pid, inp.k);
      }
    }
    for (const pid of step(r)) {
      const car = r.cars.find((c) => c.pid === pid)!;
      this.send({ v: 1, t: "lap", p: pid, lap: car.lap, laps: r.laps });
      const name = this.name(pid);
      if (car.finishMs !== null && this.firstFinishTick === null) {
        this.firstFinishTick = r.tick;
        this.banner = { key: "banner.wins", vars: { name }, tick: r.tick };
      } else if (car.lap === r.laps - 1 && r.cars.every((c) => c === car || c.lap < car.lap)) {
        this.banner = { key: "banner.finalLap", vars: { name }, tick: r.tick };
      }
    }

    for (const h of r.hits) {
      const trap = r.traps.find((t) => t.id === h.trap)!;
      this.send({ v: 1, t: "hit", trap: h.trap, car: h.pid });
      this.raceLog.hits.push({ card: trap.card, pid: h.pid });
      this.banner = { key: `hit.${trap.card}` as StringKey, vars: { name: this.name(h.pid) }, tick: r.tick };
      if (HARMFUL.has(trap.card)) this.onTrapCut?.(trap.x, trap.y);
    }

    // Lava cracks and crab crowds: public, so the TV says who got caught.
    for (const h of r.hazardHits) {
      this.banner = { key: h.kind === "lava" ? "hit.lava" : "hit.crabs", vars: { name: this.name(h.pid) }, tick: r.tick };
      this.onHazard?.(h.kind);
    }

    // A respawned car jumps; don't draw it gliding across the map.
    for (const pid of r.respawned) {
      const c = r.cars.find((c) => c.pid === pid)!;
      this.prev.set(pid, { x: c.x, y: c.y, a: c.a });
    }

    this.afterTick?.();

    const allDone = r.cars.every((c) => c.finishMs !== null);
    const graceOver = this.firstFinishTick !== null && (r.tick - this.firstFinishTick) * DT * 1000 >= FINISH_GRACE_MS;
    if (allDone || graceOver || r.tick * DT * 1000 >= MAX_RACE_MS) this.finish();
  }

  /** Interpolated pose between the last two physics steps, for smooth drawing. */
  pose(pid: string): Pose | null {
    const c = this.race?.cars.find((c) => c.pid === pid);
    if (!c) return null;
    const p = this.prev.get(pid);
    if (!p || this.phase !== "race") return { x: c.x, y: c.y, a: c.a };
    const t = this.acc / DT;
    let da = c.a - p.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    return { x: p.x + (c.x - p.x) * t, y: p.y + (c.y - p.y) * t, a: p.a + da * t };
  }

  /** After a frame is drawn: tell each phone which of its inputs is now on screen. */
  afterRender() {
    for (const [pid, k] of this.applied) {
      if (this.acked.get(pid) === k) continue;
      this.acked.set(pid, k);
      this.send({ v: 1, t: "ack", p: pid, k });
    }
  }

  /** Race points each seat earned in the race just finished. */
  racePoints(pid: string): number {
    const i = this.results.findIndex((r) => r.pid === pid);
    return i < 0 ? 0 : PLACE_POINTS[i] ?? 0;
  }

  // ---------- helpers ----------

  private countFps(deltaMs: number) {
    this.fpsFrames++;
    this.fpsMs += deltaMs;
    if (this.fpsMs < 1000) return;
    this.fps = (this.fpsFrames * 1000) / this.fpsMs;
    this.fpsFrames = 0;
    this.fpsMs = 0;
    if (this.phase === "race") this.stat.fps.push(this.fps);
  }

  private finish() {
    const r = this.race!;
    this.results = standings(r);
    this.log({
      e: "match_finished",
      track: r.track.def.id,
      players: r.cars.length,
      ms: Math.round(r.tick * DT * 1000),
      finishers: r.cars.filter((c) => c.finishMs !== null).length,
      disconnects: this.stat.disconnects,
    });
    const { stats, fps } = this.stat;
    if (stats.length) this.log({ e: "latency", p50: percentile(stats, 50)!, p95: percentile(stats, 95)!, n: stats.length });
    if (fps.length) this.log({ e: "fps", avg: Math.round(fps.reduce((a, b) => a + b, 0) / fps.length), min: Math.round(Math.min(...fps)) });
    this.stat = { stats: [], fps: [], disconnects: 0 };
    this.send({ v: 1, t: "result", places: this.results });
    this.setPhase("results", RESULTS_MS);
  }

  private setPhase(phase: Phase, ms = 0) {
    this.phase = phase;
    this.phaseLeft = ms;
    this.sendPhase();
    this.onChange();
  }

  private sendPhase() {
    const timed = this.phaseLeft > 0 && this.phase !== "lobby" && this.phase !== "podium" && this.phase !== "race";
    this.send({
      v: 1, t: "phase", phase: this.phase, laps: LAPS,
      ms: timed ? Math.max(0, this.phaseLeft) : undefined,
      race: this.phase === "lobby" ? undefined : this.raceNo,
      races: this.phase === "lobby" ? undefined : this.match.races,
      track: this.phase === "lobby" ? undefined : this.loading ?? this.track?.def.id,
      clues: this.phase === "vote" ? this.clues : undefined,
    });
  }
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
