// Host-side game flow: lobby → countdown → race → results.
// Owns the simulation, applies the latest phone inputs each tick, and tells the room what happened.

import { COUNTDOWN_MS, LAPS } from "../shared/constants";
import type { AnyMsg, LobbyMsg, Phase, PlayerInfo } from "../shared/protocol";
import { createRace, DT, standings, step, type RaceState } from "./sim";
import type { Track } from "./track";

/** After the first car finishes, the others get this long before the race ends. */
const FINISH_GRACE_MS = 15_000;
/** Hard cap so a race never stalls. */
const MAX_RACE_MS = 180_000;
const MAX_STEPS_PER_FRAME = 5;
const STAT_WINDOW = 200;

export interface Pose { x: number; y: number; a: number }

export class RaceHost {
  phase: Phase = "lobby";
  players: PlayerInfo[] = [];
  race: RaceState | null = null;
  results: { pid: string; ms: number | null }[] = [];
  countdownLeft = 0;
  /** Latest input per player; applied on the next physics tick. */
  private inputs = new Map<string, { s: -1 | 0 | 1; k: number }>();
  private applied = new Map<string, number>();
  private acked = new Map<string, number>();
  private prev = new Map<string, Pose>();
  private acc = 0;
  private firstFinishTick: number | null = null;

  /** touch → TV samples reported by phones (ms). */
  stats: number[] = [];
  lastStat = new Map<string, number>();

  constructor(
    public track: Track | null,
    private send: (m: AnyMsg) => void,
    private onChange: () => void,
  ) {}

  // ---------- messages from the room ----------

  setLobby(m: LobbyMsg) {
    this.players = m.players;
    for (const p of m.players) if (!p.on) this.inputs.set(p.pid, { s: 0, k: this.inputs.get(p.pid)?.k ?? 0 }); // dropped phone: drive straight
    if (this.race) {
      const keep = new Set(m.players.map((p) => p.pid));
      this.race.cars = this.race.cars.filter((c) => keep.has(c.pid)); // seat expired: car leaves
    }
    // A reloaded host page comes back with the room still in a race; reset the room to match.
    if (m.phase !== this.phase) this.sendPhase();
    this.onChange();
  }

  onInput(p: string, s: -1 | 0 | 1, k: number) {
    this.inputs.set(p, { s, k });
  }

  onStat(p: string, tt: number) {
    this.stats.push(tt);
    if (this.stats.length > STAT_WINDOW) this.stats.shift();
    this.lastStat.set(p, tt);
  }

  start() {
    if (this.phase !== "lobby" && this.phase !== "results") return;
    if (this.players.length === 0 || !this.track) return;
    this.race = createRace(this.track, this.players.map((p) => p.pid), LAPS);
    this.prev.clear();
    this.applied.clear();
    this.acked.clear();
    this.acc = 0;
    this.firstFinishTick = null;
    this.results = [];
    this.countdownLeft = COUNTDOWN_MS;
    this.setPhase("countdown");
  }

  backToLobby() {
    this.race = null;
    this.setPhase("lobby");
  }

  // ---------- per frame ----------

  /** Called every rendered frame with the frame time in ms. Runs fixed 60 Hz physics steps. */
  update(deltaMs: number) {
    if (this.phase === "countdown") {
      this.countdownLeft -= deltaMs;
      if (this.countdownLeft <= 0) this.setPhase("race");
      return;
    }
    if (this.phase !== "race" || !this.race) return;

    this.acc += Math.min(deltaMs / 1000, DT * MAX_STEPS_PER_FRAME);
    while (this.acc >= DT) {
      this.acc -= DT;
      this.tick();
      if (this.phase !== "race") return;
    }
  }

  private tick() {
    const r = this.race!;
    for (const c of r.cars) {
      this.prev.set(c.pid, { x: c.x, y: c.y, a: c.a });
      const inp = this.inputs.get(c.pid);
      if (inp) {
        c.steer = inp.s;
        this.applied.set(c.pid, inp.k);
      }
    }
    for (const pid of step(r)) {
      const car = r.cars.find((c) => c.pid === pid)!;
      this.send({ v: 1, t: "lap", p: pid, lap: car.lap, laps: r.laps });
      if (car.finishMs !== null && this.firstFinishTick === null) this.firstFinishTick = r.tick;
    }

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

  // ---------- helpers ----------

  private finish() {
    this.results = standings(this.race!);
    this.send({ v: 1, t: "result", places: this.results });
    this.setPhase("results");
  }

  private setPhase(phase: Phase) {
    this.phase = phase;
    this.sendPhase();
    this.onChange();
  }

  private sendPhase() {
    this.send({ v: 1, t: "phase", phase: this.phase, laps: LAPS, ms: this.phase === "countdown" ? Math.max(0, this.countdownLeft) : undefined });
  }
}

export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
