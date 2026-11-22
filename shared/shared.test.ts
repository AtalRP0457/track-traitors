import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, isValidCode, randomCode } from "./constants";
import { isListName, randomName } from "./names";
import { parseMsg, type ErrorMsg } from "./protocol";
import { ordinal, t } from "./strings";
import en from "../strings/en.json";

describe("room codes", () => {
  it("never use confusing letters", () => {
    expect(CODE_ALPHABET).not.toMatch(/[OI01]/);
    for (let i = 0; i < 200; i++) expect(isValidCode(randomCode())).toBe(true);
  });
  it("reject bad codes", () => {
    expect(isValidCode("ABC")).toBe(false);
    expect(isValidCode("ABCO")).toBe(false);
  });
});

describe("names", () => {
  it("only accepts word-list names", () => {
    expect(isListName(randomName())).toBe(true);
    expect(isListName("Bad Word")).toBe(false);
    expect(isListName("Zippy Crab extra")).toBe(false);
  });
});

describe("parseMsg", () => {
  it("requires v and t", () => {
    expect(parseMsg('{"v":1,"t":"ping","k":1}')).toEqual({ v: 1, t: "ping", k: 1 });
    expect(parseMsg('{"t":"ping"}')).toBeNull();
    expect(parseMsg('{"v":2,"t":"ping"}')).toBeNull();
    expect(parseMsg("not json")).toBeNull();
    expect(parseMsg(42)).toBeNull();
  });
});

describe("strings", () => {
  it("fills placeholders and leaves unknown ones alone", () => {
    expect(t("race.lap", { lap: 1, laps: 2 })).toBe("Lap 1/2");
    expect(t("race.lap", { lap: 1 })).toBe("Lap 1/{laps}");
  });
  it("makes English ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
  });
  it("has a text for every room error code", () => {
    const codes: ErrorMsg["code"][] = ["no_room", "full", "started", "taken", "bad_seat", "closed"];
    for (const code of codes) expect((en as Record<string, string>)[`error.${code}`]).toBeTruthy();
  });
});
