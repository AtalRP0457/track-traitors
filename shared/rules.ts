// Traitors-mode rules shared by host, phones and the room server (PLAN.md section 2 + Phase 2
// decisions). Pure data and small functions: no I/O, so tests and every side agree.

export type Card = "oil" | "crab" | "coconut" | "fake" | "boost" | "ramp";
export const CARDS: Card[] = ["oil", "crab", "coconut", "fake", "boost", "ramp"];
/** Cards that cause a "crash". Only these earn a traitor points. Boost pad and ramp help. */
export const HARMFUL: ReadonlySet<Card> = new Set<Card>(["oil", "crab", "coconut", "fake"]);
export const isCard = (x: unknown): x is Card => typeof x === "string" && (CARDS as string[]).includes(x);
/** Icon drawn on the TV once a trap goes off, and on the phone's draft cards. */
export const CARD_ICON: Record<Card, string> = { oil: "🛢️", crab: "🦀", coconut: "🥥", fake: "⚡", boost: "🚀", ramp: "⛰️" };

export const CARDS_DEALT = 3;
/** Race points by finishing place (1st … 8th). */
export const PLACE_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
export const SCORE = { trapCrash: 3, survivedVote: 5, caught: -5, wronglyAccused: 2 };

export const ROLE_MS = 5_000;
export const DRAFT_MS = 20_000;
export const VOTE_MS = 20_000;
export const REVEAL_MS = 5_000;
export const RESULTS_MS = 7_000;
export const GLITCH_MS = 2_000;
/** Bots fill empty seats up to this many racers. */
export const MIN_RACERS = 3;

export type Role = "racer" | "traitor";

export interface MatchSettings {
  races: 1 | 3 | 5;
  /** 0 = auto (1 traitor for 3–5 players, 2 for 6–8). */
  traitors: 0 | 1 | 2;
  /** Traps each player places per race. */
  cards: 1 | 2;
  bots: boolean;
  /** A track id, or "mix" to rotate through all of them. */
  track: string;
}

export const DEFAULT_SETTINGS: MatchSettings = { races: 3, traitors: 0, cards: 1, bots: true, track: "mix" };

/** Launch tracks in rotation order for "mix". Files live in public/assets/tracks/<id>.json. */
export const TRACKS = ["sunny-cove", "coconut-harbor", "lagoon-figure8"];

export function trackForRace(settings: MatchSettings, race: number): string {
  if (settings.track !== "mix" && TRACKS.includes(settings.track)) return settings.track;
  return TRACKS[(race - 1) % TRACKS.length];
}

/** How many traitors: picked among phones (bots are always racers). At least one racer stays
 *  a racer when there are 2+ phones; a lone phone can be the traitor (solo testing). */
export function traitorCount(setting: 0 | 1 | 2, humans: number, total: number): number {
  const want = setting === 0 ? (total >= 6 ? 2 : 1) : setting;
  return Math.max(0, Math.min(want, humans >= 2 ? humans - 1 : humans));
}

/** Votes happen after races 2, 3, … (and after the only race of a 1-race match). */
export function voteAfter(race: number, races: number): boolean {
  return race >= 2 || races === 1;
}

/**
 * Plurality vote. `votes` maps voter → accused pid, or "" for skip. Skip counts as an option:
 * nobody is caught if skip has the most votes, on any tie for the most, or with no votes.
 */
export function tally(votes: Iterable<string>): string | null {
  const n = new Map<string, number>();
  for (const v of votes) n.set(v, (n.get(v) ?? 0) + 1);
  let best: string | null = null;
  let top = 0;
  let tie = false;
  for (const [who, k] of n) {
    if (k > top) [best, top, tie] = [who, k, false];
    else if (k === top) tie = true;
  }
  return !best || tie ? null : best;
}

/** Fisher–Yates; `rand` injectable for tests. */
export function shuffle<T>(xs: T[], rand: () => number = Math.random): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Fixed reaction buttons on phones (no free text). They float up on the TV. */
export const REACTIONS = ["😂", "😱", "🔥", "👏", "🤔", "😈"];
/** A phone can send at most one reaction per this many ms. */
export const REACT_GAP_MS = 400;
