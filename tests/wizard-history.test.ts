import { describe, expect, it } from "vitest";
import { stepFromHash, stepHash } from "../src/domain/wizard-history";

describe("wizard history", () => {
  it("names each step in the URL, starting at step-1", () => {
    expect(stepHash(0)).toBe("#step-1");
    expect(stepHash(4)).toBe("#step-5");
  });
  it("Back and Forward land on the step in the hash, never past the furthest step reached", () => {
    expect(stepFromHash("#step-3", 4, 5)).toBe(2);
    expect(stepFromHash("#step-6", 2, 5)).toBe(2);
    expect(stepFromHash("#step-99", 9, 5)).toBe(5);
  });
  it("falls back to the first step for no or odd hashes", () => {
    for (const h of ["", "#", "#step-0", "#step-x", "#other"]) expect(stepFromHash(h, 5, 5)).toBe(0);
  });
});
