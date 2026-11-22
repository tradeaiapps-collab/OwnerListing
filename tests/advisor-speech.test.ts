import { describe, expect, it } from "vitest";
import { forSpeech, pickVoice, speechChunks } from "../src/domain/advisor-speech";

describe("advisor speech", () => {
  it("says prices and shorthand the way a person would", () => {
    expect(forSpeech("up to $650 a week")).toBe("up to 650 dollars a week");
    expect(forSpeech("$600k to $900k")).toBe("600 thousand dollars to 900 thousand dollars");
    expect(forSpeech("3+ bedrooms in QLD")).toBe("3 or more bedrooms in Queensland");
    expect(forSpeech('say "any"')).toBe("say any");
  });
  it("splits into sentences and marks questions", () => {
    const c = speechChunks("Lovely, buying. What's your budget? Say any!");
    expect(c.map(x => x.text)).toEqual(["Lovely, buying.", "What's your budget?", "Say any!"]);
    expect(c.map(x => x.question)).toEqual([false, true, false]);
    expect(speechChunks("...")).toEqual([]);
  });
  it("prefers an Australian natural voice, then British, and ignores other languages", () => {
    const v = [{ name: "Google UK English Female", lang: "en-GB" }, { name: "Microsoft Natasha Online (Natural) - English (Australia)", lang: "en-AU" }, { name: "Thomas", lang: "fr-FR" }, { name: "Daniel", lang: "en-GB" }];
    expect(pickVoice(v)?.lang).toBe("en-AU");
    expect(pickVoice(v.slice(2))?.name).toBe("Daniel");
    expect(pickVoice([{ name: "Thomas", lang: "fr-FR" }])).toBeUndefined();
  });
});
