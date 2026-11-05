import { describe, expect, it } from "vitest";
import { guardDraft } from "../src/domain/ai-output-guard";
import type { AnalysisOffer } from "../src/domain/offer-analysis";
import type { NegotiationMandate } from "../src/domain/offers";
import {
  assessRisk, coach, DEFAULT_MODEL, estimateBuyerReserve, evaluateModel, featuresOf, listingStrategy, momentumOf, nashPrice, parseOfferText,
  predictClose, redFlagsFor, renderTemplate, templatesFor, trainModel, trajectoryOf, type CoachInput, type TrainingSample
} from "../src/domain/negotiation-coach";

const clean = () => ({ blocked: false, flags: [], installed: true });
const offer = (o: Partial<AnalysisOffer> = {}): AnalysisOffer => ({
  id: "o1", priceCents: 80_000_000, depositCents: 8_000_000, settlementDays: 30, conditions: [], status: "submitted", submittedAt: "2026-10-25T01:00:00.000Z", ...o
});
const input = (o: Partial<CoachInput> = {}): CoachInput => {
  const off = o.offer ?? offer();
  return { offer: off, allOffers: [off], buyerHistory: [], listing: { transactionType: "sale", askingPriceCents: 90_000_000 }, counterRound: 0, ...o };
};
const mandate = (m: Partial<NegotiationMandate> = {}): NegotiationMandate => ({
  listingId: "L1", version: 1, floorPriceCents: 84_000_000, targetPriceCents: 90_000_000, maxCounterRounds: 3, maxConcessionBpsPerRound: 600,
  autoModeEnabled: false, approvedConditions: [], ...m
});

describe("parseOfferText", () => {
  it("reads price, deposit percent, settlement and conditions", () => {
    const p = parseOfferText("Hi, we would like to offer $850,000 with a 10% deposit and 45 day settlement, subject to finance and a building and pest inspection.");
    expect(p).toMatchObject({ priceCents: 85_000_000, depositPercent: 10, depositCents: 8_500_000, settlementDays: 45, missing: [], confidence: 1 });
    expect(p.conditions).toEqual(["Subject to finance", "Subject to building and pest inspection"]);
  });
  it("reads shorthand amounts, weeks and months", () => {
    expect(parseOfferText("$1.25m, settle in 6 weeks").priceCents).toBe(125_000_000);
    expect(parseOfferText("$1.25m, settle in 6 weeks").settlementDays).toBe(42);
    expect(parseOfferText("offer 900k cash, 2 months settlement").settlementDays).toBe(60);
    expect(parseOfferText("offer 900k cash, 2 months settlement").priceCents).toBe(90_000_000);
  });
  it("keeps a dollar deposit apart from the price", () => {
    const p = parseOfferText("$800,000 offer and a $40,000 deposit, unconditional");
    expect(p).toMatchObject({ priceCents: 80_000_000, depositCents: 4_000_000, depositPercent: 5, conditions: [] });
  });
  it("prefers the amount nearest asking when the text has several", () => {
    expect(parseOfferText("Up from $700,000 to $880,000 now", { askingPriceCents: 90_000_000 }).priceCents).toBe(88_000_000);
  });
  it("lists what is missing instead of guessing, and spots pressure", () => {
    const p = parseOfferText("This is our final offer, it expires tomorrow. Subject to sale of our home.");
    expect(p.priceCents).toBeUndefined();
    expect(p.missing).toEqual(["price", "deposit", "settlement"]);
    expect(p.pressure.length).toBe(2);
    expect(p.conditions).toEqual(["Subject to sale of the buyer's property"]);
    expect(p.confidence).toBe(0);
  });
  it("does not read percentages, days or small numbers as money", () => {
    expect(parseOfferText("10% deposit, 30 days, 3 bedrooms").priceCents).toBeUndefined();
  });
});

describe("close-probability model", () => {
  const ctx = { askingPriceCents: 90_000_000, rounds: 0, openOffers: 1, buyerRaised: false };
  it("is higher for a strong, clean offer than for a weak, conditional one", () => {
    const strong = predictClose(DEFAULT_MODEL, featuresOf(offer({ priceCents: 89_000_000, depositCents: 8_900_000 }), ctx));
    const weak = predictClose(DEFAULT_MODEL, featuresOf(offer({ priceCents: 70_000_000, depositCents: 700_000, settlementDays: 120, conditions: ["Subject to sale of the buyer's property", "Subject to finance"] }), ctx));
    expect(strong.probability).toBeGreaterThan(0.7);
    expect(weak.probability).toBeLessThan(0.15);
    expect(weak.drivers.every(d => d.effect === "hurts" || d.effect === "helps")).toBe(true);
    expect(weak.drivers[0]!.effect).toBe("hurts");
  });
  it("stays between 0 and 1 and is deterministic", () => {
    const x = featuresOf(offer({ priceCents: 1 }), ctx);
    const p = predictClose(DEFAULT_MODEL, x);
    expect(p.probability).toBeGreaterThanOrEqual(0);
    expect(p.probability).toBeLessThanOrEqual(1);
    expect(predictClose(DEFAULT_MODEL, x)).toEqual(p);
  });
  it("returns the prior unchanged with too little data or only one outcome", () => {
    const few: TrainingSample[] = Array.from({ length: 10 }, (_, i) => ({ x: featuresOf(offer(), ctx), y: (i % 2) as 0 | 1 }));
    expect(trainModel(few)).toEqual(DEFAULT_MODEL);
    const oneSided: TrainingSample[] = Array.from({ length: 60 }, () => ({ x: featuresOf(offer(), ctx), y: 1 as const }));
    expect(trainModel(oneSided)).toEqual(DEFAULT_MODEL);
  });
  it("learns from closed and failed deals: a world where finance conditions kill deals moves the weight and improves the score", () => {
    // Synthetic history: finance-conditional offers fail 90% of the time, clean ones close 90% of the time.
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const samples: TrainingSample[] = [];
    for (let i = 0; i < 200; i++) {
      const finance = i % 2 === 0;
      const x = featuresOf(offer({ priceCents: 86_000_000, conditions: finance ? ["Subject to finance"] : [] }), ctx);
      samples.push({ x, y: (rnd() < (finance ? 0.1 : 0.9) ? 1 : 0) as 0 | 1 });
    }
    const learned = trainModel(samples);
    expect(learned.source).toBe("learned");
    expect(learned.trainedOn).toBe(200);
    expect(learned.weights[4]!).toBeLessThan(DEFAULT_MODEL.weights[4]! - 0.5);
    expect(evaluateModel(learned, samples).brier).toBeLessThan(evaluateModel(DEFAULT_MODEL, samples).brier);
    expect(trainModel(samples)).toEqual(learned);
  });
});

describe("buyer trajectory and bargaining", () => {
  it("orders the buyer's prices by time and reads momentum", () => {
    const t = trajectoryOf({ offer: offer({ priceCents: 80, submittedAt: "2026-10-03" }), buyerHistory: [{ priceCents: 60, submittedAt: "2026-10-01" }, { priceCents: 70, submittedAt: "2026-10-02" }] });
    expect(t).toEqual([60, 70, 80]);
    expect(momentumOf(t)).toBe("rising");
    expect(momentumOf([80, 70])).toBe("retreating");
    expect(momentumOf([80])).toBe("unknown");
  });
  it("shrinking steps imply a nearby ceiling, capped at asking", () => {
    const r = estimateBuyerReserve([70_000_000, 78_000_000, 82_000_000], 95_000_000, 0);
    // steps 8m then 4m: ratio 0.5, remaining = 4m * 0.5 / 0.5 = 4m, so about 86m
    expect(r).toEqual({ cents: 86_000_000, confidence: "high" });
    expect(estimateBuyerReserve([70_000_000, 90_000_000], 95_000_000, 0).cents).toBe(95_000_000);
    expect(estimateBuyerReserve([80_000_000], 90_000_000, 0).confidence).toBe("low");
  });
  it("gives the seller a larger share of the zone with competing offers", () => {
    expect(nashPrice(80, 100, 0)).toBe(90);
    expect(nashPrice(80, 100, 2)).toBe(94);
    expect(nashPrice(80, 100, 9)).toBe(96);
    expect(nashPrice(80, 70, 0)).toBe(80);
  });
});

describe("coach", () => {
  it("returns three ordered scenarios between the offer and asking, with probabilities that make sense", () => {
    const c = coach(input());
    expect(c.scenarios.map(s => s.key)).toEqual(["firm", "balanced", "quick"]);
    const [firm, balanced, quick] = c.scenarios;
    expect(firm!.priceCents).toBeGreaterThanOrEqual(balanced!.priceCents);
    expect(balanced!.priceCents).toBeGreaterThanOrEqual(quick!.priceCents);
    for (const s of c.scenarios) {
      expect(s.priceCents).toBeGreaterThan(80_000_000);
      expect(s.priceCents).toBeLessThanOrEqual(90_000_000);
      expect(s.closeProbability).toBeCloseTo(s.acceptProbability * s.completionProbability, 1);
    }
    expect(firm!.acceptProbability).toBeLessThanOrEqual(balanced!.acceptProbability);
    expect(c.recommended).toBeDefined();
    expect(c.summary).toMatch(/nothing is sent or accepted/);
  });
  it("is deterministic", () => {
    expect(coach(input())).toEqual(coach(input()));
  });
  it("never counters an offer at or above asking, and says it is the seller's call", () => {
    const c = coach(input({ offer: offer({ priceCents: 91_000_000 }), allOffers: [offer({ priceCents: 91_000_000 })] }));
    expect(c.scenarios).toEqual([]);
    expect(c.summary).toMatch(/your call/);
  });
  it("gives no counter for an offer the same buyer has already replaced", () => {
    const c = coach(input({ buyerHistory: [{ priceCents: 85_000_000, submittedAt: "2026-10-26T00:00:00.000Z" }] }));
    expect(c.scenarios).toEqual([]);
  });
  it("keeps every scenario at or above the floor and within the per-round concession, without ever exposing the floor", () => {
    const c = coach(input({ mandate: mandate() }));
    for (const s of c.scenarios) {
      expect(s.priceCents).toBeGreaterThanOrEqual(84_000_000);
      expect(s.priceCents).toBeGreaterThanOrEqual(90_000_000 * 0.94);
      expect(s.withinMandate).toBe(true);
    }
    expect(JSON.stringify(c)).not.toMatch(/84000000|84,000,000|floor/i);
  });
  it("moves less when the seller has already countered (concession is measured from the standing ask)", () => {
    const c = coach(input({ mandate: mandate({ maxConcessionBpsPerRound: 300 }), standingAskCents: 88_000_000 }));
    for (const s of c.scenarios) expect(s.priceCents).toBeGreaterThanOrEqual(Math.ceil(88_000_000 * 0.97 / 100_000) * 100_000);
  });
  it("holds firmer and rates the close chance lower when a competing offer exists", () => {
    const rival = offer({ id: "o2", priceCents: 88_000_000 });
    const alone = coach(input());
    const contested = coach(input({ allOffers: [offer(), rival] }));
    const a = alone.scenarios.find(s => s.key === "balanced")!, b = contested.scenarios.find(s => s.key === "balanced")!;
    expect(b.priceCents).toBeGreaterThanOrEqual(a.priceCents);
    expect(contested.likelihoodAsIs.probability).toBeLessThan(alone.likelihoodAsIs.probability);
  });
  it("uses a learned model when one is passed in and says so", () => {
    const learned = { ...DEFAULT_MODEL, source: "learned" as const, trainedOn: 120 };
    expect(coach(input(), learned).model).toEqual({ source: "learned", trainedOn: 120, version: DEFAULT_MODEL.version });
    expect(coach(input()).model.source).toBe("prior");
  });
  it("works for rent without cost contributions", () => {
    const c = coach(input({ listing: { transactionType: "rent", askingPriceCents: 90_000 }, offer: offer({ priceCents: 80_000, depositCents: 0, settlementDays: 14 }), allOffers: [offer({ priceCents: 80_000 })] }));
    expect(c.scenarios.length).toBeGreaterThan(0);
    expect(c.scenarios.every(s => s.costContributionCents === 0)).toBe(true);
    expect(c.concessionIdeas.every(i => i.kind !== "costs")).toBe(true);
  });
});

describe("risk and red flags", () => {
  it("scores a clean at-asking offer low and a conditional, long, thin one high", () => {
    expect(assessRisk(input({ offer: offer({ priceCents: 90_000_000 }) })).level).toBe("low");
    const high = assessRisk(input({ offer: offer({ priceCents: 70_000_000, depositCents: 100_000, settlementDays: 150, conditions: ["Subject to sale of my home", "Subject to finance", "Subject to building and pest"] }) }));
    expect(high.level).toBe("high");
    expect(high.parts.map(p => p.key)).toEqual(["price", "finance", "timeline", "conditions"]);
  });
  it("counts verification only when it is known", () => {
    const r = assessRisk(input({ buyerVerified: { email: true, phone: false, id: false } }));
    expect(r.parts.find(p => p.key === "verification")).toMatchObject({ score: 67 });
  });
  it("flags a retreat, tiny steps, no deposit, a sale-dependent thin deposit and pressure", () => {
    expect(redFlagsFor(input(), [85, 80]).map(f => f.code)).toContain("buyer_retreated");
    const tiny = redFlagsFor(input({ offer: offer({ priceCents: 80_200_000 }) }), [80_000_000, 80_100_000, 80_200_000]);
    expect(tiny.map(f => f.code)).toContain("tiny_increments");
    expect(redFlagsFor(input({ offer: offer({ depositCents: 0 }) }), [80]).map(f => f.code)).toContain("no_deposit");
    expect(redFlagsFor(input({ offer: offer({ depositCents: 2_000_000, conditions: ["Subject to sale of my home"] }) }), [80]).map(f => f.code)).toContain("sale_dependent_thin");
    expect(redFlagsFor(input(), [80], ["short expiry"]).map(f => f.code)).toContain("pressure");
  });
});

describe("multi-party strategy", () => {
  const entry = (id: string, label: string, o: Partial<AnalysisOffer>, all: AnalysisOffer[]) => ({ offerId: id, label, coach: coach(input({ offer: offer({ id, ...o }), allOffers: all })) });
  it("ranks offers by expected result and advises best-and-final when the top offers are within 3%", () => {
    const a = offer({ id: "a", priceCents: 88_000_000 }), b = offer({ id: "b", priceCents: 87_000_000 });
    const s = listingStrategy([entry("a", "Offer A", { priceCents: 88_000_000 }, [a, b]), entry("b", "Offer B", { priceCents: 87_000_000 }, [a, b])], 90_000_000);
    expect(s.bestAndFinalAdvised).toBe(true);
    expect(s.ranking).toHaveLength(2);
    expect(s.ranking[0]!.expectedNetCents).toBeGreaterThanOrEqual(s.ranking[1]!.expectedNetCents);
    expect(s.notes.join(" ")).toMatch(/highest and final/);
  });
  it("flags a sale-dependent offer next to a cleaner one, and says a lone offer gives less leverage", () => {
    const a = offer({ id: "a", priceCents: 88_000_000, conditions: ["Subject to sale of my home"] }), b = offer({ id: "b", priceCents: 82_000_000 });
    const s = listingStrategy([entry("a", "Offer A", a, [a, b]), entry("b", "Offer B", b, [a, b])], 90_000_000);
    expect(s.notes.join(" ")).toMatch(/Offer A depends on the buyer selling/);
    expect(listingStrategy([entry("a", "Offer A", {}, [offer({ id: "a" })])], 90_000_000).notes.join(" ")).toMatch(/one open offer/);
  });
  it("warns when every offer is far below asking", () => {
    const a = offer({ id: "a", priceCents: 70_000_000 });
    expect(listingStrategy([entry("a", "Offer A", a, [a])], 90_000_000).notes.join(" ")).toMatch(/more than 15% below/);
  });
});

describe("message templates", () => {
  const result = coach(input({ mandate: mandate() }));
  const all = templatesFor(result, "sale", 80_000_000, 90_000_000, { includeBestAndFinal: true });
  it("makes a counter per scenario plus the standard messages", () => {
    expect(all.map(t => t.kind)).toEqual(["counter_firm", "counter_balanced", "counter_quick", "best_and_final", "request_information", "holding_message", "decline_politely"]);
  });
  it("every template passes the same draft guard the AI drafts pass, with the floor and other offers kept out", () => {
    for (const t of all) {
      const g = guardDraft(t.text, { wordingFilter: clean, allowedAmountsCents: t.allowedAmountsCents, floorPriceCents: 84_000_000 });
      expect(g, `${t.kind}: ${g.violations.map(v => v.message).join(" ")}`).toEqual({ ok: true, violations: [] });
    }
  });
  it("states only amounts it is allowed to, and never promises", () => {
    const counter = all.find(t => t.kind === "counter_balanced")!;
    expect(counter.text).toContain(`$${(result.scenarios[1]!.priceCents / 100).toLocaleString("en-AU")}`);
    expect(counter.text).toMatch(/Nothing is agreed until contracts are exchanged/);
    expect(counter.text).not.toMatch(/\b(accept|deal done|sold)\b/i);
  });
  it("mentions other offers only when the seller opts in", () => {
    const plain = renderTemplate("best_and_final", { tx: "sale", offerCents: 80_000_000 });
    const opted = renderTemplate("best_and_final", { tx: "sale", offerCents: 80_000_000, mentionOtherOffers: true });
    expect(guardDraft(plain, { wordingFilter: clean, allowedAmountsCents: [] }).ok).toBe(true);
    expect(guardDraft(opted, { wordingFilter: clean, allowedAmountsCents: [] }).violations.map(v => v.code)).toContain("other_buyers");
    expect(guardDraft(opted, { wordingFilter: clean, allowedAmountsCents: [], ownerAllowsOtherOffersMention: true }).ok).toBe(true);
  });
  it("shows the cost contribution of the quick scenario in the text and in the allowed amounts", () => {
    const quick = result.scenarios.find(s => s.key === "quick")!;
    const t = all.find(x => x.kind === "counter_quick")!;
    expect(quick.costContributionCents).toBeGreaterThan(0);
    expect(t.allowedAmountsCents).toContain(quick.costContributionCents);
    expect(t.text).toMatch(/conveyancing costs/);
  });
});
