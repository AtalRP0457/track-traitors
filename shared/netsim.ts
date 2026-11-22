// Dev-only network simulator: adds lag, jitter and loss to one client's traffic.
// Delivery order is kept (WebSocket is ordered). Loss only drops messages marked droppable
// (steering input), because over WebSocket only a future unreliable channel could lose them
// and the 1/s heartbeat recovers a dropped input.

export interface NetSimConfig {
  /** One-way delay added in each direction, ms. */
  lag: number;
  /** Extra random delay 0..jitter ms. */
  jitter: number;
  /** Chance (0–100 %) to drop a droppable outgoing message. */
  loss: number;
}

export const NO_SIM: NetSimConfig = { lag: 0, jitter: 0, loss: 0 };

export class NetSim {
  private outDue = 0;
  private inDue = 0;
  dropped = 0;

  constructor(public cfg: NetSimConfig = { ...NO_SIM }, private rand: () => number = Math.random) {}

  get active() {
    return this.cfg.lag > 0 || this.cfg.jitter > 0 || this.cfg.loss > 0;
  }

  /** Run fn as if the message took the simulated trip out. Returns false if it was dropped. */
  out(fn: () => void, droppable = false): boolean {
    if (!this.active) return fn(), true;
    if (droppable && this.rand() * 100 < this.cfg.loss) {
      this.dropped++;
      return false;
    }
    this.outDue = this.schedule(this.outDue, fn);
    return true;
  }

  /** Wrap an incoming-message handler so it runs after the simulated trip in. */
  in<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
    return (...a: A) => {
      if (!this.active) return fn(...a);
      this.inDue = this.schedule(this.inDue, () => fn(...a));
    };
  }

  private schedule(lastDue: number, fn: () => void): number {
    const now = performance.now();
    const due = Math.max(lastDue, now + this.cfg.lag + this.rand() * this.cfg.jitter);
    setTimeout(fn, due - now);
    return due;
  }
}

/** Read ?lag=&jitter=&loss= from a URL query (for testing a real phone). */
export function simFromQuery(q: URLSearchParams): NetSimConfig {
  const n = (k: string, max: number) => Math.max(0, Math.min(max, Number(q.get(k)) || 0));
  return { lag: n("lag", 2000), jitter: n("jitter", 1000), loss: n("loss", 100) };
}
