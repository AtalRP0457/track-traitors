// Network protocol shared by host, phones and the room server.
// Every message has `v` (protocol version) and `t` (type). See PLAN.md section 4.

export const PROTOCOL_VERSION = 1;

export type Phase = "lobby" | "countdown" | "race" | "results";

export interface PlayerInfo {
  pid: string;
  name: string;
  color: string;
  /** false while the phone is disconnected but its seat is still held */
  on: boolean;
}

// ---------- phone → room ----------

/** First message after (re)connecting. pid + seat are empty on a first join. */
export interface JoinMsg { v: 1; t: "join"; pid: string; seat: string; name: string; color: string }
/** Steering input. s = -1/0/1, b = brake, g = glitch, k = input sequence number. */
export interface InputMsg { v: 1; t: "in"; s: -1 | 0 | 1; b: 0 | 1; g: 0 | 1; k: number }
/** Round-trip probe. Answered by the host (h:1) or by the room if no host is online (h:0).
 *  r = the phone's current median round trip (ms), shown per player on the host overlay. */
export interface PingMsg { v: 1; t: "ping"; k: number; r?: number }
/** VIP asks to start (or restart after results). */
export interface StartReqMsg { v: 1; t: "startreq" }
/** Measured touch → TV time for one input, in ms. Used for the latency gate. */
export interface StatMsg { v: 1; t: "stat"; tt: number }

export type PhoneToRoom = JoinMsg | InputMsg | PingMsg | StartReqMsg | StatMsg;

// ---------- host → room ----------

export interface HostHelloMsg { v: 1; t: "hosthello"; seat: string }
/** ms = time left in this phase (countdown), measured from when the message arrives. */
export interface PhaseMsg { v: 1; t: "phase"; phase: Phase; laps: number; ms?: number }
/** Reply to a forwarded ping. */
export interface PongMsg { v: 1; t: "pong"; k: number; p?: string; h?: 0 | 1 }
/** Host applied input k from player p and drew the frame. */
export interface AckMsg { v: 1; t: "ack"; k: number; p?: string }
/** Lap progress for one player (forwarded only to that phone). */
export interface LapMsg { v: 1; t: "lap"; p: string; lap: number; laps: number }
export interface ResultMsg { v: 1; t: "result"; places: { pid: string; ms: number | null }[] }

export type HostToRoom = HostHelloMsg | PhaseMsg | PongMsg | AckMsg | LapMsg | ResultMsg;

// ---------- room → host ----------

export interface LobbyMsg { v: 1; t: "lobby"; code: string; players: PlayerInfo[]; vip: string | null; phase: Phase; host: boolean }
/** Input forwarded to the host with the sender's pid. */
export interface FwdInputMsg { v: 1; t: "in"; p: string; s: -1 | 0 | 1; b: 0 | 1; g: 0 | 1; k: number }
export interface FwdPingMsg { v: 1; t: "ping"; p: string; k: number; r?: number }
export interface StartMsg { v: 1; t: "start"; mode: "classic"; track: string }
export interface FwdStatMsg { v: 1; t: "stat"; p: string; tt: number }

export type RoomToHost = LobbyMsg | FwdInputMsg | FwdPingMsg | StartMsg | FwdStatMsg | ErrorMsg;

// ---------- room → phone ----------

export interface WelcomeMsg { v: 1; t: "welcome"; pid: string; seat: string; name: string; color: string }
export interface ErrorMsg { v: 1; t: "error"; code: "no_room" | "full" | "started" | "taken" | "bad_seat" | "closed"; msg: string }

export type RoomToPhone = WelcomeMsg | LobbyMsg | PhaseMsg | PongMsg | AckMsg | LapMsg | ResultMsg | ErrorMsg;

export type AnyMsg = PhoneToRoom | HostToRoom | RoomToHost | RoomToPhone;

/** Parse an incoming frame. Returns null for anything that isn't a v1 message with a type. */
export function parseMsg(raw: unknown): { v: number; t: string; [k: string]: unknown } | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== "object" || m.v !== PROTOCOL_VERSION || typeof m.t !== "string") return null;
    return m;
  } catch {
    return null;
  }
}

export function encode(m: AnyMsg): string {
  return JSON.stringify(m);
}
