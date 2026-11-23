// Turns a vote clue into a sentence (host screen and phones show the same text).

import type { Clue } from "./protocol";
import { t } from "./strings";

export function clueText(c: Clue, name: (pid: string) => string): string {
  const n = c.n ?? 0;
  switch (c.k) {
    case "hits":
      return t(n === 1 ? "clue.hits1" : "clue.hits", { name: name(c.p ?? ""), n });
    case "clean":
      return t("clue.clean", { name: name(c.p ?? "") });
    case "glitched":
      return t("clue.glitched", { name: name(c.p ?? "") });
    case "unsprung":
      return t(n === 1 ? "clue.unsprung1" : "clue.unsprung", { n });
  }
}
