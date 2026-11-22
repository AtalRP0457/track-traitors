// All on-screen text lives in strings/en.json (PLAN.md section 12). Use t("key", {vars}).
// Dev-only screens (/dev, the D overlay on the host) are exempt.

import en from "../strings/en.json";

export type StringKey = keyof typeof en;

export function t(key: StringKey, vars?: Record<string, string | number>): string {
  const s: string = en[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n: number): string {
  const teen = n % 100 > 10 && n % 100 < 14;
  const d = n % 10;
  const key = !teen && (d === 1 || d === 2 || d === 3) ? (`ordinal.${d}` as StringKey) : "ordinal.other";
  return t(key, { n });
}
