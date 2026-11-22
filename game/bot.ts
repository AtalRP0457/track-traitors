// Bot driver: looks a bit ahead on the track's racing line and presses left/right like a
// player would. Produces only steering input (-1/0/1), never positions.

import { pointAt, project, type Track } from "./track";

export interface BotBrain {
  /** Last racing-line segment, so projection stays local and cheap. */
  hint: number;
  /** How far ahead on the line it aims (px). Shorter = twitchier. */
  lookahead: number;
  /** Heading error (rad) it tolerates before pressing a button. Bigger = sloppier. */
  deadzone: number;
  /** Current button and how many ticks it has been held: a thumb can't change ~60×/s. */
  steer: -1 | 0 | 1;
  held: number;
}

/** Minimum ticks between button changes (6 ticks = 100 ms, a fast human thumb). */
export const MIN_HOLD_TICKS = 6;

export function newBrain(skill = 1): BotBrain {
  return { hint: -1, lookahead: 60 + 30 * skill, deadzone: 0.04 + 0.12 * (1 - skill), steer: 0, held: 0 };
}

/** Call once per physics tick. Returns the button the bot holds this tick. */
export function botSteer(track: Track, b: BotBrain, x: number, y: number, a: number): -1 | 0 | 1 {
  b.held++;
  const p = project(track.line, x, y, b.hint);
  b.hint = p.i;
  const ahead = pointAt(track.line, p.s + b.lookahead);
  let diff = Math.atan2(ahead.y - y, ahead.x - x) - a;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  const want = diff > b.deadzone ? 1 : diff < -b.deadzone ? -1 : 0;
  if (want !== b.steer && b.held >= MIN_HOLD_TICKS) {
    b.steer = want;
    b.held = 0;
  }
  return b.steer;
}
