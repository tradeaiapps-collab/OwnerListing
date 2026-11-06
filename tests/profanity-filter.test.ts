import { describe, expect, it } from "vitest";
import { findProfanity, hasProfanity } from "../src/domain/profanity-filter";

describe("profanity filter", () => {
  it.each(["fuck", "What the FUCK", "f**k", "f*ck", "sh1t", "sh*t", "a$$hole", "fuuuuck", "f u c k", "f.u.c.k", "wtf", "stfu", "kys", "fck this", "n1gger", "go back to your country", "I will kill you", "kill yourself", "you should die", "shut up", "Fuck!"])(
    "flags %s", t => expect(hasProfanity(t), t).toBe(true));
  it.each(["Kitchen with stone benchtop", "Office", "Bright living room with a classic fireplace", "Scunthorpe Street frontage", "Assembly hall, grass lawn", "Pass-through to the dining room", "Cocktail bar, cockatoo views", "Hello, 3 bed 2 bath!", "Dickson shops nearby", "Skyline view, 5 minute walk", "Peacock Lane", "bass guitar room"])(
    "allows %s", t => expect(hasProfanity(t), t).toBe(false));
  it("reports what matched", () => expect(findProfanity("f**k this shit")).toEqual(["fuck", "shit"]));
  it("handles empty text", () => expect(findProfanity("")).toEqual([]));
});
