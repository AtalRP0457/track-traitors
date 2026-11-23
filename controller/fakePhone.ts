// Dev-only fake phone controller. Speaks the exact phone protocol over a real WebSocket:
// join, input only on change + 1/s heartbeat, ping for RTT, stat for touch → TV.
// It doesn't decide where to steer; the host's bot relay tells it (see game/devbots.ts).
// In a Traitors match it also plays along: places its cards on a random trap-zone spot,
// votes for someone random (or skips), and as a traitor glitches a random rival mid-race.

import { HEARTBEAT_MS, PING_MS } from "../shared/constants";
import { randomName } from "../shared/names";
import { openRoom, send } from "../shared/net";
import { NetSim, type NetSimConfig } from "../shared/netsim";
import { parseMsg, type AnyMsg, type Phase } from "../shared/protocol";
import type { PartySocket } from "partysocket";
import type { Card, Role } from "../shared/rules";
import { fetchTrackFile } from "../shared/track-format";
import { buildTrack, type Track } from "../game/track";
import { snapTrap, trapZonePaths } from "../game/traps";

const tracks = new Map<string, Promise<Track>>();
function loadTrack(id: string): Promise<Track> {
  if (!tracks.has(id)) tracks.set(id, fetchTrackFile(id).then(buildTrack));
  return tracks.get(id)!;
}
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const later = (minMs: number, maxMs: number, fn: () => void) => setTimeout(fn, minMs + Math.random() * (maxMs - minMs));

export interface FakePhoneView {
  id: number;
  name: string;
  color: string;
  pid: string;
  status: string;
  phase: Phase;
  rtt: number | null;
  tt: number | null;
  steer: -1 | 0 | 1;
  /** Messages sent / received in the last second. */
  outRate: number;
  inRate: number;
  dropped: number;
  role: Role | null;
}

export class FakePhone {
  readonly sim: NetSim;
  private ws: PartySocket;
  private timers: ReturnType<typeof setInterval>[] = [];
  private k = 0;
  private pk = 0;
  private pings = new Map<number, number>();
  private touchAt = new Map<number, number>();
  private rtts: number[] = [];
  private outCount = 0;
  private inCount = 0;
  private others: string[] = [];
  private pending: ReturnType<typeof setTimeout>[] = [];
  view: FakePhoneView;

  constructor(id: number, readonly room: string, simCfg: NetSimConfig, private onChange: () => void) {
    this.sim = new NetSim(simCfg);
    this.view = { id, name: randomName(), color: "", pid: "", status: "connecting", phase: "lobby", rtt: null, tt: null, steer: 0, outRate: 0, inRate: 0, dropped: 0, role: null };
    this.ws = openRoom(room, "phone");
    // Fake phones don't keep a seat across page reloads; each /dev load joins fresh.
    let seat = { pid: "", seat: "" };
    this.ws.addEventListener("open", () => {
      this.view.status = "joining";
      this.tx({ v: 1, t: "join", pid: seat.pid, seat: seat.seat, name: this.view.name, color: "" });
      this.onChange();
    });
    this.ws.addEventListener("close", () => {
      if (this.view.status !== "stopped" && !this.view.status.startsWith("error")) this.view.status = "reconnecting";
      this.onChange();
    });
    this.ws.addEventListener(
      "message",
      this.sim.in((e: MessageEvent) => {
        this.inCount++;
        const m = parseMsg(e.data);
        if (!m) return;
        switch (m.t) {
          case "welcome":
            seat = { pid: String(m.pid), seat: String(m.seat) };
            Object.assign(this.view, { pid: seat.pid, name: String(m.name), color: String(m.color), status: "in room" });
            break;
          case "phase":
            this.view.phase = m.phase as Phase;
            if (this.view.phase !== "race") this.setSteer(0);
            this.onPhase(m);
            break;
          case "lobby":
            this.others = (m.players as { pid: string }[]).map((p) => p.pid).filter((p) => p !== this.view.pid);
            break;
          case "seats":
            this.others = [...new Set([...this.others, ...(m.bots as { pid: string }[]).map((b) => b.pid)])];
            break;
          case "role":
            this.view.role = m.role as Role;
            this.mates = (m.mates as string[]) ?? [];
            this.caught = m.caught === true;
            break;
          case "draft":
            this.place(m.cards as Card[], Number(m.n), String(m.track));
            break;
          case "pong": {
            const at = this.pings.get(Number(m.k));
            if (at === undefined) break;
            this.pings.delete(Number(m.k));
            this.rtts.push(performance.now() - at);
            if (this.rtts.length > 5) this.rtts.shift();
            this.view.rtt = median(this.rtts);
            break;
          }
          case "ack": {
            const at = this.touchAt.get(Number(m.k));
            if (at === undefined) break;
            this.touchAt.delete(Number(m.k));
            const tt = Math.max(0, performance.now() - at - (this.view.rtt ?? 0) / 2);
            this.view.tt = tt;
            this.tx({ v: 1, t: "stat", tt: Math.round(tt) });
            break;
          }
          case "error":
            this.view.status = `error: ${m.code}`;
            this.ws.close();
            break;
        }
        this.onChange();
      }),
    );

    this.timers.push(
      setInterval(() => {
        this.pings.set(++this.pk, performance.now());
        if (this.pings.size > 10) this.pings.delete(this.pk - 10);
        this.tx({ v: 1, t: "ping", k: this.pk, r: this.view.rtt === null ? undefined : Math.round(this.view.rtt) });
      }, PING_MS),
      setInterval(() => this.tx({ v: 1, t: "in", s: this.view.steer, b: 0, g: 0, k: this.k }), HEARTBEAT_MS),
      setInterval(() => {
        this.view.outRate = this.outCount;
        this.view.inRate = this.inCount;
        this.view.dropped = this.sim.dropped;
        this.outCount = this.inCount = 0;
        this.onChange();
      }, 1000),
    );
  }

  private mates: string[] = [];
  private caught = false;

  private onPhase(m: { [k: string]: unknown }) {
    if (m.phase === "vote") {
      // Vote for a random phone (bots can't be voted), sometimes skip.
      const phones = this.others.filter((p) => p.startsWith("p"));
      this.pending.push(later(1500, 6000, () => this.tx({ v: 1, t: "vote", who: Math.random() < 0.2 || phones.length === 0 ? "" : pick(phones) })));
    }
    if (m.phase === "race" && this.view.role === "traitor" && !this.caught) {
      const rivals = this.others.filter((p) => !this.mates.includes(p));
      if (rivals.length) this.pending.push(later(8000, 35000, () => this.view.phase === "race" && this.tx({ v: 1, t: "glitch", target: pick(rivals) })));
    }
  }

  /** Place each card it must on a random spot inside a trap zone, after a short "thinking" pause. */
  private place(cards: Card[], n: number, trackId: string) {
    loadTrack(trackId)
      .then((t) => {
        const hand = [...cards];
        for (let i = 0; i < n && hand.length; i++) {
          const card = hand.splice(Math.floor(Math.random() * hand.length), 1)[0];
          const zone = pick(trapZonePaths(t));
          const [x, y] = pick(zone);
          const p = snapTrap(t, x + (Math.random() - 0.5) * t.def.width * 0.6, y + (Math.random() - 0.5) * t.def.width * 0.6)!;
          this.pending.push(later(1000 + i * 1500, 5000 + i * 1500, () => this.tx({ v: 1, t: "place", card, x: Math.round(p.x), y: Math.round(p.y) })));
        }
      })
      .catch(() => {});
  }

  /** The bot "presses" a button. Sent only when it changes, like a real thumb. */
  setSteer(s: -1 | 0 | 1) {
    if (s === this.view.steer) return;
    this.view.steer = s;
    const k = ++this.k;
    this.touchAt.set(k, performance.now());
    if (this.touchAt.size > 20) this.touchAt.delete(k - 20);
    this.tx({ v: 1, t: "in", s, b: 0, g: 0, k });
  }

  setSim(cfg: NetSimConfig) {
    this.sim.cfg = { ...cfg };
  }

  stop() {
    this.view.status = "stopped";
    this.timers.forEach(clearInterval);
    this.pending.forEach(clearTimeout);
    this.ws.close();
  }

  private tx(msg: AnyMsg) {
    this.sim.out(() => {
      this.outCount++;
      send(this.ws, msg);
    }, msg.t === "in");
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
