// Numbers shared by host, phones and the room server.

export const MAX_PLAYERS = 8;
export const LAPS = 2;
/** How long the room keeps a dropped phone's seat (and a dropped host's room). */
export const SEAT_HOLD_MS = 60_000;
export const HEARTBEAT_MS = 1_000;
export const PING_MS = 2_000;
export const COUNTDOWN_MS = 3_000;
export const PARTY_NAME = "room";

/** Room code letters: no O or I so codes can't be confused with 0 or 1. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;

/** Car colors players can pick. Blue is the racer color from PLAN.md; orange is reserved for traps. */
export const CAR_COLORS = [
  "#4DA3FF", // blue
  "#FF4D6D", // red
  "#3DDC84", // green
  "#FFD23F", // yellow
  "#B57BFF", // purple
  "#2EE6D6", // teal
  "#FF8FD1", // pink
  "#F5F5F5", // white
];

/** Latency dot thresholds (round-trip ms). */
export const RTT_GREEN = 80;
export const RTT_YELLOW = 160;

export function randomCode(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

export function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}
