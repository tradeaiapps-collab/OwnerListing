import { describe, expect, it } from "vitest";
import type { AiEnginePort } from "../src/domain/ai-engine";
import { rulesOnlyEngine } from "../src/domain/ai-engine";
import { findingsParagraph, isGrounded, readInspectionReport } from "../src/domain/inspection-findings";

const report = "Building inspection report. Overall condition: average for age. Active termite activity was found in the rear fence posts. " +
  "Cracking up to 5 mm wide was noted in the north brick wall. The roof tiles are in fair condition with two cracked tiles. ".repeat(2);
const engine = (reply: string): AiEnginePort => ({ info: () => ({ id: "t", kind: "self_hosted", version: "1" }), readDocument: async () => "", describePhoto: async () => [], generate: async () => reply });

describe("isGrounded", () => {
  it("accepts a restated finding and rejects invented facts or changed figures", () => {
    expect(isGrounded("Active termite activity found in the rear fence posts", report)).toBe(true);
    expect(isGrounded("Cracking up to 5 mm wide in the north brick wall", report)).toBe(true);
    expect(isGrounded("Cracking up to 50 mm wide in the north brick wall", report)).toBe(false);
    expect(isGrounded("Asbestos was found in the roof sheeting", report)).toBe(false);
  });
});

describe("readInspectionReport", () => {
  it("keeps only grounded findings", async () => {
    const r = await readInspectionReport(engine("- Active termite activity found in the rear fence posts\n- Asbestos found in the roof sheeting\n- Call 0412 345 678 about termite activity"), report);
    expect(r).toEqual({ state: "ok", findings: [{ text: "Active termite activity found in the rear fence posts" }] });
  });
  it("reports unreadable and off states without inventing anything", async () => {
    expect((await readInspectionReport(engine("x"), "  ")).state).toBe("no_text");
    expect((await readInspectionReport(rulesOnlyEngine, report)).state).toBe("unavailable");
    expect(findingsParagraph([])).toBe("");
  });
});
