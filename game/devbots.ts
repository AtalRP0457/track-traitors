// Dev-only: drives the /dev page's fake phones. After every physics tick it works out which
// button each fake phone's bot would press and, only when that changes, tells the /dev tab.

import { openDevChannel, type DevMsg } from "../shared/devchannel";
import { botSteer, newBrain, type BotBrain } from "./bot";
import type { RaceHost } from "./race";
import type { RaceState } from "./sim";

/** Forget a fake phone if /dev stops mentioning it (tab closed). */
const STALE_MS = 3000;

export class DevBotRelay {
  private ch = openDevChannel();
  private bots = new Map<string, { brain: BotBrain; last: -1 | 0 | 1 | null; seen: number }>();
  private race: RaceState | null = null;

  constructor(private host: RaceHost, private room: string) {
    if (!this.ch) return;
    this.ch.onmessage = (e: MessageEvent<DevMsg>) => {
      const m = e.data;
      if (m?.v !== 1 || m.t !== "bots" || m.room !== this.room) return;
      const now = performance.now();
      for (const pid of m.pids) {
        const b = this.bots.get(pid);
        if (b) b.seen = now;
        // Different skill per bot so they spread out instead of driving in a perfect line.
        else this.bots.set(pid, { brain: newBrain(0.35 + Math.random() * 0.6), last: null, seen: now });
      }
      for (const [pid, b] of this.bots) if (now - b.seen > STALE_MS) this.bots.delete(pid);
    };
    host.afterTick = () => this.tick();
  }

  get count() {
    return this.bots.size;
  }

  private tick() {
    const r = this.host.race;
    if (!r || !this.ch) return;
    if (r !== this.race) {
      this.race = r; // new race: resend everything
      for (const b of this.bots.values()) {
        b.last = null;
        b.brain = { ...b.brain, hint: -1, steer: 0, held: 0 };
      }
    }
    for (const c of r.cars) {
      const b = this.bots.get(c.pid);
      if (!b) continue;
      const s = botSteer(r.track, b.brain, c.x, c.y, c.a);
      if (s === b.last) continue;
      b.last = s;
      this.ch.postMessage({ v: 1, t: "steer", room: this.room, pid: c.pid, s } satisfies DevMsg);
    }
  }

  dispose() {
    if (this.host.afterTick) this.host.afterTick = undefined;
    this.ch?.close();
  }
}
