import { describe, expect, it } from "vitest";
import { cleanTranscript, micErrorMessage } from "../src/domain/guide-voice";

describe("cleanTranscript", () => {
  it("joins pieces and collapses whitespace", () => {
    expect(cleanTranscript(["  how do I ", "", "list   my house "], 100)).toBe("how do I list my house");
  });
  it("returns empty for nothing heard", () => {
    expect(cleanTranscript([" ", ""], 100)).toBe("");
  });
  it("caps at max on a word boundary", () => {
    const out = cleanTranscript(["one two three four five six seven eight"], 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toBe("one two three four");
  });
  it("hard-cuts a single long word", () => {
    expect(cleanTranscript(["abcdefghijklmnop"], 5)).toBe("abcde");
  });
});

describe("micErrorMessage", () => {
  it("explains a blocked microphone", () => {
    expect(micErrorMessage("not-allowed")).toMatch(/blocked/);
  });
  it("has a fallback", () => {
    expect(micErrorMessage("whatever")).toMatch(/try again/);
  });
});
