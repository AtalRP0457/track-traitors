// Analytics events (PLAN.md sections 10 + 12). No personal data: pids are random, names
// come from the word list and are never logged.
// Phase 1 sink: a ring buffer in localStorage (+ console in dev). Phase 3 swaps the sink for
// the API Worker (sendBeacon) without touching callers.

export type AnalyticsEvent =
  | { e: "room_created" }
  /** Phone opened /play. via = "qr" when the room code came in the link. */
  | { e: "join_opened"; via: "qr" | "code" }
  | { e: "player_joined"; pid: string; players: number }
  | { e: "match_started"; track: string; players: number }
  | { e: "match_finished"; track: string; players: number; ms: number; finishers: number; disconnects: number }
  /** Phase 2: traitor vote outcome. */
  | { e: "vote_result"; caught: number; traitors: number }
  | { e: "disconnect"; who: "phone" | "host"; pid?: string; phase: string }
  /** touch → TV for one match, from phone stat reports. */
  | { e: "latency"; p50: number; p95: number; n: number }
  /** Host frame rate for one match. */
  | { e: "fps"; avg: number; min: number };

export type Logged = AnalyticsEvent & { at: number; sid: string; room?: string; role: "host" | "phone" };
export type Sink = (ev: Logged) => void;

const KEY = "tt-events";
const KEEP = 200;

const sid = Math.random().toString(36).slice(2, 10);
const context: { room?: string; role: "host" | "phone" } = { role: "host" };

/** Default sink: keep the last 200 events in localStorage so they can be inspected (or sent later). */
export const storageSink: Sink = (ev) => {
  if (typeof localStorage === "undefined") return;
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Logged[];
    list.push(ev);
    localStorage.setItem(KEY, JSON.stringify(list.slice(-KEEP)));
  } catch {}
  if (process.env.NODE_ENV !== "production") console.debug("[tt]", ev.e, ev);
};

let sink: Sink = storageSink;

export const analytics = {
  setSink(s: Sink) {
    sink = s;
  },
  setContext(c: Partial<typeof context>) {
    Object.assign(context, c);
  },
  log(ev: AnalyticsEvent) {
    try {
      sink({ ...ev, at: Date.now(), sid, ...context });
    } catch {} // analytics must never break the game
  },
  /** Events stored on this device (newest last). */
  stored(): Logged[] {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "[]");
    } catch {
      return [];
    }
  },
};
