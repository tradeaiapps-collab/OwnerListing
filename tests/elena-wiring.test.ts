import { describe, expect, it } from "vitest";
import {
  adjustLeadWeights, CONTROL_ARM, experimentReport, featureCoverage, nextUpdateAdvice, rankSuggestions, WEIGHT_READERS, weightsApply, wilsonInterval,
  type LearnedConfig, type SuggestionFact
} from "../src/domain/elena-learning";
import { stableId } from "../src/server/elena-wiring-db";

const config = (typeWeights: Record<string, number>): LearnedConfig => ({ engine: "elena-learning-v1", typeWeights, regionWeights: {}, trainedOn: 100 });
const NOW = "2026-11-05T00:00:00Z";
const fact = (over: Partial<SuggestionFact>): SuggestionFact => ({ id: "i", feature: "negotiation_coach", type: "t", userRole: "owner", consent: false, context: {}, createdAt: NOW, ...over });

describe("which settings a person gets", () => {
  it("applies learned weights only when a config with weights is active and the arm is not control", () => {
    expect(weightsApply(undefined, undefined)).toBe(false);
    expect(weightsApply(config({}), undefined)).toBe(false);
    expect(weightsApply(config({ "x/y": 1.2 }), undefined)).toBe(true);
    expect(weightsApply(config({ "x/y": 1.2 }), "learned")).toBe(true);
    expect(weightsApply(config({ "x/y": 1.2 }), CONTROL_ARM)).toBe(false);
  });

  it("names the features that read weights", () => {
    expect([...WEIGHT_READERS].sort()).toEqual(["lead_scoring", "mediation", "negotiation_coach"]);
  });

  it("scales lead-scoring signal weights and leaves unlearned ones alone", () => {
    const w = { engagement: 60, fit: 25, followUp: 15 };
    expect(adjustLeadWeights(undefined, w)).toEqual(w);
    expect(adjustLeadWeights(config({ "lead_scoring/engagement": 1.5, "lead_scoring/follow_up": 0.5 }), w)).toEqual({ engagement: 90, fit: 25, followUp: 7.5 });
    expect(adjustLeadWeights(config({ "pricing/balanced": 1.5 }), w)).toEqual(w);
  });

  it("rank order is unchanged without a config, and the same set comes back with one", () => {
    const c = [{ feature: "mediation" as const, type: "a", baseScore: 1 }, { feature: "mediation" as const, type: "b", baseScore: 1 }];
    expect(rankSuggestions(undefined, undefined, c).map(x => x.type)).toEqual(["a", "b"]);
    expect(rankSuggestions(config({ "mediation/b": 1.3 }), undefined, c).map(x => x.type)).toEqual(["b", "a"]);
  });

  it("makes stable, valid uuids from the same inputs", () => {
    const a = stableId("x", "1", "2");
    expect(a).toBe(stableId("x", "1", "2"));
    expect(a).not.toBe(stableId("x", "1", "3"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("dashboard figures", () => {
  it("reports per feature whether it reads weights, outcome coverage and use of weights, over 30 days", () => {
    const facts = [
      fact({ id: "1", feature: "lead_scoring", action: "accepted", context: { weighted: true } }),
      fact({ id: "2", feature: "lead_scoring", context: { weighted: false } }),
      fact({ id: "3", feature: "pricing", action: "ignored" }),
      fact({ id: "4", feature: "pricing", createdAt: "2026-01-01T00:00:00Z" })
    ];
    const rows = featureCoverage(facts, NOW);
    const lead = rows.find(r => r.feature === "lead_scoring")!;
    expect(lead).toMatchObject({ readsWeights: true, suggestions: 2, withReaction: 1, coverage: 0.5, weightedShare: 0.5, ok: false });
    expect(rows.find(r => r.feature === "pricing")).toMatchObject({ readsWeights: false, suggestions: 1, coverage: 1, ok: true });
    // Readers always show, even with nothing recorded yet.
    expect(rows.map(r => r.feature)).toEqual(expect.arrayContaining(["negotiation_coach", "mediation", "lead_scoring"]));
  });

  it("gives a Wilson interval that narrows with more data", () => {
    const small = wilsonInterval(8, 10), big = wilsonInterval(80, 100);
    expect(small.upper - small.lower).toBeGreaterThan(big.upper - big.lower);
    expect(big.lower).toBeLessThan(0.8);
    expect(big.upper).toBeGreaterThan(0.8);
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 0 });
  });

  it("compares arms on acceptance, settled share, days and rating", () => {
    const facts: SuggestionFact[] = [];
    for (let i = 0; i < 20; i++) facts.push(fact({ id: `c${i}`, arm: "control", experimentKey: "e", action: i < 8 ? "accepted" : "rejected", dealOutcome: i < 10 ? "settled" : "fell_through", dealDays: 40, rating: 3 }));
    for (let i = 0; i < 20; i++) facts.push(fact({ id: `l${i}`, arm: "learned", experimentKey: "e", action: i < 18 ? "accepted" : "rejected", dealOutcome: "settled", dealDays: 30, rating: 5 }));
    const r = experimentReport(facts, ["control", "learned"]);
    const [c, l] = r.arms;
    expect(c).toMatchObject({ arm: "control", n: 20, successRate: 0.4, dealsKnown: 20, conversion: 0.5, medianDays: 40, meanRating: 3 });
    expect(l).toMatchObject({ arm: "learned", n: 20, successRate: 0.9, conversion: 1, medianDays: 30, meanRating: 5 });
    expect(l!.lower).toBeLessThan(0.9);
    expect(l!.upper).toBeGreaterThan(0.9);
    expect(r.winner).toBe("learned");
  });

  it("recommends when to retrain", () => {
    expect(nextUpdateAdvice(5, undefined, NOW, false)).toMatch(/25 more/);
    expect(nextUpdateAdvice(50, undefined, NOW, true)).toMatch(/waiting/);
    expect(nextUpdateAdvice(50, undefined, NOW, false)).toMatch(/Run the monthly job now/);
    expect(nextUpdateAdvice(50, "2026-10-20T00:00:00Z", NOW, false)).toMatch(/in about 14 days/);
    expect(nextUpdateAdvice(50, "2026-09-20T00:00:00Z", NOW, false)).toMatch(/46 days old/);
  });
});
