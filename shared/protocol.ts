// Network protocol shared by host, phones and the room server.
// Every message has `v` (protocol version) and `t` (type). See PLAN.md section 4.

import type { Card, MatchSettings, Role } from "./rules";

export const PROTOCOL_VERSION = 1;

/** Match flow: lobby → role → (draft → countdown → race → results → [vote → reveal]) × races → podium. */
export type Phase = "lobby" | "role" | "draft" | "countdown" | "race" | "results" | "vote" | "reveal" | "podium";
export const PHASES: Phase[] = ["lobby", "role", "draft", "countdown", "race", "results", "vote", "reveal", "podium"];

/** A public fact about the last race shown before a vote. Never says who placed anything. */
export interface Clue { k: "hits" | "clean" | "glitched" | "unsprung"; p?: string; n?: number }

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
/** Place one drafted card at a road point (host snaps/validates it). */
export interface PlaceMsg { v: 1; t: "place"; card: Card; x: number; y: number }
/** Traitor: reverse this rival's steering for 2 s (once per race). */
export interface GlitchReqMsg { v: 1; t: "glitch"; target: string }
/** Vote for who: a pid, or "" to skip. */
export interface VoteMsg { v: 1; t: "vote"; who: string }
/** Reaction emoji, index into REACTIONS. */
export interface ReactMsg { v: 1; t: "react"; e: number }

export type PhoneToRoom = JoinMsg | InputMsg | PingMsg | StartReqMsg | StatMsg | PlaceMsg | GlitchReqMsg | VoteMsg | ReactMsg;

// ---------- host → room ----------

export interface HostHelloMsg { v: 1; t: "hosthello"; seat: string }
/** ms = time left in this phase, measured from when the message arrives.
 *  race/races = which race of the match; track = that race's track; clues before a vote. */
export interface PhaseMsg { v: 1; t: "phase"; phase: Phase; laps: number; ms?: number; race?: number; races?: number; track?: string; clues?: Clue[] }
/** Reply to a forwarded ping. */
export interface PongMsg { v: 1; t: "pong"; k: number; p?: string; h?: 0 | 1 }
/** Host applied input k from player p and drew the frame. */
export interface AckMsg { v: 1; t: "ack"; k: number; p?: string }
/** Lap progress for one player (forwarded only to that phone). */
export interface LapMsg { v: 1; t: "lap"; p: string; lap: number; laps: number }
export interface ResultMsg { v: 1; t: "result"; places: { pid: string; ms: number | null }[] }
/** A bot seat (host-side car, always a racer, never votes). */
export interface BotInfo { pid: string; name: string; color: string }
/** New match: room assigns secret roles to the phones and resets scores. */
export interface MatchMsg { v: 1; t: "match"; settings: MatchSettings; bots: BotInfo[] }
/** A car set off trap #trap (index into the last `traps` list). */
export interface HitMsg { v: 1; t: "hit"; trap: number; car: string }
/** Host closes the vote; the room tallies it. */
export interface VoteEndMsg { v: 1; t: "voteend" }

export type HostToRoom = HostHelloMsg | PhaseMsg | PongMsg | AckMsg | LapMsg | ResultMsg | MatchMsg | HitMsg | VoteEndMsg;

// ---------- room → host ----------

export interface LobbyMsg { v: 1; t: "lobby"; code: string; players: PlayerInfo[]; vip: string | null; phase: Phase; host: boolean }
/** Input forwarded to the host with the sender's pid. */
export interface FwdInputMsg { v: 1; t: "in"; p: string; s: -1 | 0 | 1; b: 0 | 1; g: 0 | 1; k: number }
export interface FwdPingMsg { v: 1; t: "ping"; p: string; k: number; r?: number }
export interface StartMsg { v: 1; t: "start"; mode: "traitors" }
export interface FwdStatMsg { v: 1; t: "stat"; p: string; tt: number }
/** Draft / vote progress: n of `of` phones are done. */
export interface ProgressMsg { v: 1; t: "progress"; n: number; of: number }
/** This race's traps, shuffled, positions only. Never owners. */
export interface TrapsMsg { v: 1; t: "traps"; race: number; list: [Card, number, number][] }
/** Glitch someone. Never says who sent it. */
export interface FwdGlitchMsg { v: 1; t: "glitch"; target: string }
export interface FwdReactMsg { v: 1; t: "react"; p: string; e: number }
/** Vote outcome: who was caught (or null) and whether they really were a traitor. */
export interface VoteResultMsg { v: 1; t: "voteresult"; caught: string | null; traitor: boolean }
/** Match totals so far (all seats, bots included). */
export interface ScoresMsg { v: 1; t: "scores"; scores: Record<string, number> }
/** End of match: everyone learns who the traitors were. */
export interface RevealMsg { v: 1; t: "reveal"; traitors: string[] }

export type RoomToHost = LobbyMsg | FwdInputMsg | FwdPingMsg | StartMsg | FwdStatMsg | ErrorMsg | ProgressMsg | TrapsMsg | FwdGlitchMsg | FwdReactMsg | VoteResultMsg | ScoresMsg | RevealMsg;

// ---------- room → phone ----------

export interface WelcomeMsg { v: 1; t: "welcome"; pid: string; seat: string; name: string; color: string }
export interface ErrorMsg { v: 1; t: "error"; code: "no_room" | "full" | "started" | "taken" | "bad_seat" | "closed"; msg: string }

/** Secret, to one phone: its role; traitors also get their fellow traitors. caught = already voted out. */
export interface RoleMsg { v: 1; t: "role"; role: Role; mates: string[]; caught: boolean }
/** To one phone: cards dealt for this race and how many to place. */
export interface DraftMsg { v: 1; t: "draft"; cards: Card[]; n: number; ms: number; track: string }
/** To one phone: the traps it has placed this race (only its own). */
export interface MyTrapsMsg { v: 1; t: "mytraps"; list: [Card, number, number][] }
/** To the glitched phone: your steering is reversed for ms. */
export interface GlitchedMsg { v: 1; t: "glitched"; ms: number }
/** To the traitor phone: your glitch went through (or not). */
export interface GlitchOkMsg { v: 1; t: "glitchok"; ok: boolean }
/** Everyone in the room, bots included, for vote buttons and scoreboards on phones. */
export interface SeatsMsg { v: 1; t: "seats"; bots: BotInfo[] }

export type RoomToPhone =
  | WelcomeMsg | LobbyMsg | PhaseMsg | PongMsg | AckMsg | LapMsg | ResultMsg | ErrorMsg
  | RoleMsg | DraftMsg | MyTrapsMsg | GlitchedMsg | GlitchOkMsg | VoteResultMsg | ScoresMsg | RevealMsg | ProgressMsg | SeatsMsg;

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
