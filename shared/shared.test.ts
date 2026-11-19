import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, isValidCode, randomCode } from "./constants";
import { isListName, randomName } from "./names";
import { parseMsg } from "./protocol";

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
