import { describe, expect, it } from "vitest";
import { compareOffers, counterDraftFrom, questionsFor, type CompareInput } from "../src/domain/offer-compare";
import type { Scenario } from "../src/domain/negotiation-coach";

const offer = (o: Partial<CompareInput> & { id: string }): CompareInput => ({
  priceCents: 80_000_000, depositCents: 8_000_000, settlementDays: 42, conditions: [], status: "submitted", submittedAt: "2026-11-01T00:00:00.000Z", ...o
});
const ASKING = 85_000_000;

describe("offer comparison", () => {
  it("labels open offers A, B by age, leaves closed ones out and carries no buyer identity", () => {
    const c = compareOffers([
      offer({ id: "b", submittedAt: "2026-11-03T00:00:00.000Z" }), offer({ id: "a", submittedAt: "2026-11-01T00:00:00.000Z" }),
      offer({ id: "x", status: "rejected" }), offer({ id: "y", status: "accepted" })
    ], ASKING);
    expect(c.columns.map(x => [x.id, x.label])).toEqual([["a", "Offer A"], ["b", "Offer B"]]);
    expect(JSON.stringify(c)).not.toMatch(/buyer_user|buyerId|email|phone/i);
  });

  it("shows price against asking, deposit share, finance state and the reply-by time", () => {
    const c = compareOffers([
      offer({ id: "a", priceCents: 82_000_000, depositCents: 4_100_000, conditions: ["Subject to finance"], openCounter: { expiresAt: "2026-11-10T00:00:00.000Z" }, prequal: { state: "verified", label: "Verified" } }),
      offer({ id: "b", priceCents: 85_000_000, depositCents: 8_500_000, conditions: ["Subject to finance"], submittedAt: "2026-11-02T00:00:00.000Z" })
    ], ASKING);
    const [a, b] = c.columns;
    expect(a!.versusAsking?.text).toBe("−3.53% below asking");
    expect(b!.versusAsking?.text).toBe("At asking");
    expect(a!.depositPercent).toBe(5);
    expect(a!.finance).toBe("verified");
    expect(a!.financeText).toMatch(/still subject to finance/);
    expect(b!.finance).toBe("condition");
    expect(a!.replyBy).toBe("2026-11-10T00:00:00.000Z");
    expect(b!.replyBy).toBeUndefined();
  });

  it("marks the best of each clear-cut row, and nobody when all are equal", () => {
    const c = compareOffers([
      offer({ id: "a", priceCents: 82_000_000, settlementDays: 30 }),
      offer({ id: "b", priceCents: 85_000_000, settlementDays: 60, conditions: ["Subject to finance"], submittedAt: "2026-11-02T00:00:00.000Z" })
    ], ASKING);
    expect(c.columns.map(x => x.best.price)).toEqual([false, true]);
    expect(c.columns.map(x => x.best.settlement)).toEqual([true, false]);
    expect(c.columns.map(x => x.best.conditions)).toEqual([true, false]);
    const same = compareOffers([offer({ id: "a" }), offer({ id: "b", submittedAt: "2026-11-02T00:00:00.000Z" })], ASKING);
    expect(same.columns.every(x => !x.best.price && !x.best.deposit && !x.best.settlement && !x.best.conditions)).toBe(true);
  });

  it("explains the trade-off in plain language: highest price that is less certain, and the clean alternative", () => {
    const c = compareOffers([
      offer({ id: "a", priceCents: 84_000_000, conditions: ["Subject to finance", "Subject to building and pest", "Subject to sale of their home"] }),
      offer({ id: "b", priceCents: 82_000_000, submittedAt: "2026-11-02T00:00:00.000Z", settlementDays: 30 })
    ], ASKING);
    const text = c.summary.join(" ");
    expect(text).toMatch(/Offer A is the highest price/);
    expect(text).toMatch(/less certain/);
    expect(text).toMatch(/Offer B has no conditions/);
    expect(text).toMatch(/Offer B settles soonest, in 30 days/);
  });

  it("handles none and one open offer", () => {
    expect(compareOffers([], ASKING).summary[0]).toMatch(/no open offers/i);
    expect(compareOffers([offer({ id: "a" })], ASKING).summary[0]).toMatch(/only open offer/);
  });

  it("compares the newest 8 and counts the rest", () => {
    const many = Array.from({ length: 11 }, (_, i) => offer({ id: `o${i}`, submittedAt: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    const c = compareOffers(many, ASKING);
    expect(c.columns).toHaveLength(8);
    expect(c.omitted).toBe(3);
    expect(c.columns[0]!.id).toBe("o3");
  });

  it("suggests questions about that offer only, with no dollar amounts", () => {
    const q = questionsFor(offer({ id: "a", priceCents: 70_000_000, depositCents: 100_000, settlementDays: 120, conditions: ["Subject to finance", "Subject to sale of their home", "Building and pest inspection"] }), ASKING);
    expect(q.length).toBeLessThanOrEqual(4);
    expect(q.join(" ")).toMatch(/pre-approval/);
    expect(q.join(" ")).not.toMatch(/\$|\d{3},\d{3}|\d+(\.\d+)?%/);
    expect(questionsFor(offer({ id: "b", conditions: ["Cash buyer"], depositCents: 8_000_000 }), ASKING).join(" ")).not.toMatch(/deposit/);
  });

  it("never leaks another offer's terms into an offer's questions", () => {
    const c = compareOffers([
      offer({ id: "a", priceCents: 81_234_500, conditions: ["Unique clause alpha"] }),
      offer({ id: "b", priceCents: 83_999_900, conditions: ["Unique clause beta"], submittedAt: "2026-11-02T00:00:00.000Z" })
    ], ASKING);
    expect(c.columns[0]!.questions.join(" ")).not.toMatch(/beta|83,999,900|839999/);
    expect(c.columns[1]!.questions.join(" ")).not.toMatch(/alpha|81,234,500/);
  });
});

describe("counter-offer draft", () => {
  const scenario = (o: Partial<Scenario> = {}): Scenario => ({
    key: "balanced", label: "Meet in the middle", priceCents: 83_000_000, depositPercent: 10, settlementDays: 45, conditionsKept: ["Subject to finance"], conditionsDropped: [],
    expiryDays: 3, costContributionCents: 0, concessions: [], acceptProbability: 0.6, completionProbability: 0.8, closeProbability: 0.48, expectedNetCents: 1, withinMandate: true, reasoning: ["a", "b", "c", "d", "e"], ...o
  });
  it("turns a scenario into terms that pass the normal counter checks", () => {
    const d = counterDraftFrom(scenario())!;
    expect(d.terms).toEqual({ priceCents: 83_000_000, depositCents: 8_300_000, settlementDays: 45, conditions: ["Subject to finance"], expiresInDays: 3 });
    expect(d.reasoning).toHaveLength(4);
    expect(d.scenario).toBe("balanced");
  });
  it("keeps the reply time inside the counter rules and refuses terms the counter route would refuse", () => {
    expect(counterDraftFrom(scenario({ expiryDays: 99 }))!.terms.expiresInDays).toBe(14);
    expect(counterDraftFrom(scenario({ expiryDays: 0 }))!.terms.expiresInDays).toBe(1);
    expect(counterDraftFrom(scenario({ priceCents: 0 }))).toBeUndefined();
    expect(counterDraftFrom(scenario({ settlementDays: 0 }))).toBeUndefined();
  });
});
