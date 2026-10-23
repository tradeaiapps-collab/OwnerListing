import { describe, expect, it } from "vitest";
import { selectEngine, toTrainingRecord, type HumanDecisionEvent } from "../src/domain/ai-learning";

const ev: HumanDecisionEvent = {
  id: "e1", occurredAt: "2026-10-22T00:00:00.000Z", area: "negotiation",
  aiSuggestion: "Email bob@example.com or call 0412 345 678", humanAction: "edited",
  situation: { round: 2, offerPctOfList: 96 }, subjectKey: "k1", consentForTraining: true
};

describe("ai learning", () => {
  it("defaults to prompts and templates until an admin chooses", () => {
    expect(selectEngine()).toBe("prompts_templates");
    expect(selectEngine({ engine: "trained_model", changedBy: "a", changedAt: "x" })).toBe("trained_model");
  });
  it("collects nothing without consent", () => {
    expect(toTrainingRecord({ ...ev, consentForTraining: false })).toBeNull();
  });
  it("redacts contact details and drops the subject key", () => {
    const r = toTrainingRecord(ev)!;
    expect(r.aiSuggestion).not.toContain("bob@example.com");
    expect(r.aiSuggestion).not.toContain("0412");
    expect("subjectKey" in r).toBe(false);
  });
});
