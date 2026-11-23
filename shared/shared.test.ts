import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, isValidCode, randomCode } from "./constants";
import { isListName, randomName } from "./names";
import { parseMsg, type ErrorMsg } from "./protocol";
import { ordinal, t, trackName } from "./strings";
import { adDue, FREE_MATCHES } from "./ads";
import { BEGINNER_TRACK, DEFAULT_SETTINGS, matchTracks, TRACKS } from "./rules";
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

describe("match tracks", () => {
  const base = { ...DEFAULT_SETTINGS, races: 5 as const };
  it("a brand-new host starts on the walled beginner track, never mirrored", () => {
    for (let i = 0; i < 20; i++) expect(matchTracks({ ...base, mirror: "mix" }, 5, true)[0]).toBe(BEGINNER_TRACK);
  });
  it("mix uses different tracks before repeating", () => {
    const list = matchTracks(base, 5, false);
    expect(new Set(list).size).toBe(5);
    list.forEach((id) => expect(TRACKS).toContain(id));
  });
  it("a chosen track is used every race; Mirror on flips them all", () => {
    expect(matchTracks({ ...base, track: "volcano-rim" }, 3, true)).toEqual(["volcano-rim", "volcano-rim", "volcano-rim"]);
    expect(matchTracks({ ...base, track: "volcano-rim", mirror: "on" }, 2, false)).toEqual(["volcano-rim~m", "volcano-rim~m"]);
  });
  it("names Mirror versions", () => {
    expect(trackName("volcano-rim~m")).toBe("Volcano Rim (Mirror)");
    expect(trackName("sandcastle-circuit")).toBe("Sandcastle Circuit");
  });
});

describe("ads rule", () => {
  it("no ads for the first 20 matches, then between matches; never offline", () => {
    for (let n = 0; n < FREE_MATCHES; n++) expect(adDue(n)).toBe(false);
    expect(adDue(20)).toBe(true); // 20 done → before match 21
    expect(adDue(57)).toBe(true);
    expect(adDue(57, false)).toBe(false);
  });
});
