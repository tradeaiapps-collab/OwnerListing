import { describe, expect, it } from "vitest";
import {
  acceptanceBy, assignArm, buildUserPattern, experimentResult, healthOf, MAX_SHIFT, MIN_SAMPLE, proposeConfig, rankSuggestions, sanitiseContext, successScore, weightFor, wilsonLower,
  type FeedbackAction, type SuggestionFact
} from "../src/domain/elena-learning";

let n = 0;
const fact = (o: Partial<SuggestionFact> = {}): SuggestionFact => ({
  id: `s${n++}`, feature: "negotiation_coach", type: "recommend_counter", userRole: "owner", region: "NSW", consent: true, context: {}, createdAt: "2026-11-01T00:00:00Z", ...o
});
const many = (k: number, o: Partial<SuggestionFact>) => Array.from({ length: k }, () => fact(o));

describe("success and acceptance", () => {
  it("scores reactions and blends in the deal outcome", () => {
    expect(successScore(fact())).toBeUndefined();
    expect(successScore(fact({ action: "accepted" }))).toBe(1);
    expect(successScore(fact({ action: "modified" }))).toBe(0.6);
    expect(successScore(fact({ dealOutcome: "fell_through" }))).toBe(0);
    expect(successScore(fact({ action: "accepted", dealOutcome: "fell_through" }))).toBeCloseTo(0.6);
  });
  it("ranks a big good sample above a tiny perfect one (Wilson lower bound)", () => {
    expect(wilsonLower(90, 100)).toBeGreaterThan(wilsonLower(3, 3));
    const rows = acceptanceBy([...many(3, { type: "tiny", action: "accepted" }), ...many(100, { type: "big", action: "accepted" }), ...many(10, { type: "big", action: "rejected" })], "type");
    expect(rows[0]!.key).toBe("big");
    expect(rows.find(r => r.key === "big")!.acceptanceRate).toBeCloseTo(100 / 110);
  });
  it("splits by state and role", () => {
    const rows = acceptanceBy([...many(4, { region: "NSW", action: "accepted" }), ...many(4, { region: "VIC", action: "rejected" })], "region");
    expect(rows.map(r => r.key).sort()).toEqual(["NSW", "VIC"]);
  });
});

describe("context hygiene", () => {
  it("keeps coded facts and drops free text and contact details", () => {
    expect(sanitiseContext({ round: 2, risk: "high", ok: true, note: "call me on john@x.com", name: "John Smith", "bad key": 1, nan: NaN })).toEqual({ round: 2, risk: "high", ok: true });
  });
});

describe("user patterns", () => {
  it("is unknown under 5 reactions and ignores people who did not consent", () => {
    expect(buildUserPattern(many(4, { action: "accepted" })).style).toBe("unknown");
    expect(buildUserPattern(many(10, { action: "accepted", consent: false })).sampleSize).toBe(0);
  });
  it("reads style, pace and risk tolerance", () => {
    const acts: FeedbackAction[] = ["accepted", "accepted", "accepted", "accepted", "accepted", "rejected"];
    const p = buildUserPattern(acts.map(action => fact({ action, responseSeconds: 120, context: { risk: "high" } })));
    expect(p.style).toBe("accepts_as_is");
    expect(p.pace).toBe("fast");
    expect(p.riskTolerance).toBe("high");
    expect(buildUserPattern(many(6, { action: "modified" })).style).toBe("editor");
  });
});

describe("learned config", () => {
  it("proposes nothing under the minimum sample", () => {
    const p = proposeConfig(many(MIN_SAMPLE - 1, { action: "accepted" }));
    expect(p.enough).toBe(false);
    expect(p.config.typeWeights).toEqual({});
  });
  it("weights good types up and bad types down, within the cap", () => {
    const facts = [...many(40, { type: "good", action: "accepted" }), ...many(40, { type: "bad", action: "rejected" })];
    const w = proposeConfig(facts).config.typeWeights;
    expect(w["negotiation_coach/good"]).toBeGreaterThan(1);
    expect(w["negotiation_coach/bad"]).toBeLessThan(1);
    for (const v of Object.values(w)) { expect(v).toBeGreaterThanOrEqual(1 - MAX_SHIFT); expect(v).toBeLessThanOrEqual(1 + MAX_SHIFT); }
  });
  it("adds a regional weight only where a state clearly differs", () => {
    const facts = [...many(20, { region: "NSW", action: "accepted" }), ...many(20, { region: "VIC", action: "rejected" })];
    const c = proposeConfig(facts).config;
    expect(c.regionWeights["VIC"]?.["negotiation_coach/recommend_counter"]).toBeLessThan(1);
    expect(proposeConfig([...many(20, { region: "NSW", action: "accepted" }), ...many(20, { region: "VIC", action: "accepted" })]).config.regionWeights).toEqual({});
  });
  it("shrinks small groups toward neutral", () => { expect(weightFor(1, 2, 0.5)).toBeLessThan(weightFor(1, 400, 0.5)); });
  it("re-orders candidates by the config and leaves them alone without one", () => {
    const cands = [{ feature: "negotiation_coach" as const, type: "a", baseScore: 1 }, { feature: "negotiation_coach" as const, type: "b", baseScore: 0.9 }];
    expect(rankSuggestions(undefined, "NSW", cands).map(c => c.type)).toEqual(["a", "b"]);
    const cfg = { engine: "elena-learning-v1" as const, typeWeights: { "negotiation_coach/b": 1.4 }, regionWeights: {}, trainedOn: 50 };
    expect(rankSuggestions(cfg, "NSW", cands).map(c => c.type)).toEqual(["b", "a"]);
  });
});

describe("A/B tests", () => {
  it("assigns the same arm every time and uses every arm", () => {
    expect(assignArm("exp", "u1", ["a", "b"])).toBe(assignArm("exp", "u1", ["a", "b"]));
    const seen = new Set(Array.from({ length: 50 }, (_, i) => assignArm("exp", `u${i}`, ["a", "b"])));
    expect(seen.size).toBe(2);
  });
  it("names a winner only on a clear difference", () => {
    const clear = experimentResult([...many(40, { arm: "a", action: "accepted" }), ...many(40, { arm: "b", action: "rejected" })], ["a", "b"]);
    expect(clear.winner).toBe("a");
    expect(experimentResult([...many(20, { arm: "a", action: "accepted" }), ...many(20, { arm: "b", action: "accepted" })], ["a", "b"]).winner).toBeUndefined();
    expect(experimentResult(many(3, { arm: "a", action: "accepted" }), ["a", "b"]).note).toMatch(/needs/);
  });
});

describe("health", () => {
  it("reports capture against the 80% target and the acceptance trend", () => {
    const now = "2026-11-05T00:00:00Z";
    const recent = [...many(9, { action: "accepted", createdAt: "2026-10-25T00:00:00Z" }), ...many(1, { createdAt: "2026-10-25T00:00:00Z" })];
    const older = [...many(8, { action: "rejected", createdAt: "2026-09-20T00:00:00Z" }), ...many(2, { action: "accepted", createdAt: "2026-09-20T00:00:00Z" })];
    const h = healthOf([...recent, ...older], [{ outcome: "settled", timeToSettlementDays: 30 }, { outcome: "fell_through" }], now);
    expect(h.captureRate).toBe(1 - 1 / 20);
    expect(h.captureOk).toBe(true);
    expect(h.acceptanceChange).toBeGreaterThan(0.5);
    expect(h.settlementRate).toBe(0.5);
    expect(h.medianDaysToSettlement).toBe(30);
    expect(healthOf([], [], now).captureOk).toBe(false);
  });
});
