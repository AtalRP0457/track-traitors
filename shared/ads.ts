// Ads rule (PLAN.md section 6). Pure, so it can be tested and every caller agrees.
//   Matches 1–20 on a host device: no ads.
//   After that: one short ad on the big screen between matches only. Never during a race,
//   never on phones, never offline. A blocked or failed ad just continues.

export const FREE_MATCHES = 20;
/** Never wait longer than this for an ad; play always goes on. */
export const AD_TIMEOUT_MS = 15_000;

/** Is an ad due before the next match? `completed` = matches finished on this host device. */
export function adDue(completed: number, online = true): boolean {
  return online && completed >= FREE_MATCHES;
}
