import { describe, expect, it } from "vitest";
import { allSuggestions, compareHistory, coachingActive, suggestionsFor, type CoachFacts } from "../src/domain/settlement-coach";

const base = (o: Partial<Omit<CoachFacts, "offer">> & { offer?: Partial<CoachFacts["offer"]> } = {}): CoachFacts => ({
  side: "seller", currentStage: "deposit_received", askingPriceCents: 100_000_000, transactionType: "sale", inspectionTargetDays: 10,
  buyer: { financed: false, verifiedPrequal: true, firstTime: false, inspectionsBooked: 1 }, seller: { otherOffers: 0, daysOnMarket: 20 },
  ...o, offer: { priceCents: 100_000_000, depositCents: 10_000_000, settlementDays: 42, conditions: ["Subject to building and pest inspection"], ...o.offer }
});
const types = (f: CoachFacts) => suggestionsFor(f).map(s => s.type);

describe("settlement coach rules", () => {
  it("says nothing about a healthy deal", () => { expect(allSuggestions(base())).toEqual([]); });
  it("flags a waived inspection, and not when an inspection is booked", () => {
    expect(types(base({ offer: { conditions: [] }, buyer: { financed: false, verifiedPrequal: true, firstTime: false, inspectionsBooked: 0 } }))).toContain("inspection_waived");
    expect(types(base({ offer: { conditions: [] } }))).not.toContain("inspection_waived");
  });
  it("flags a short inspection window and an unrealistic completion date", () => {
    expect(types(base({ inspectionTargetDays: 2 }))).toContain("inspection_window_short");
    expect(types(base({ offer: { settlementDays: 10 } }))).toContain("settlement_too_short");
    expect(types(base({ offer: { settlementDays: 20, conditions: ["Subject to finance"] } }))).toContain("settlement_too_short");
    expect(types(base({ offer: { settlementDays: 20 } }))).not.toContain("settlement_too_short");
  });
  it("flags a long settlement, a low deposit, a sale-dependent deal and unverified finance", () => {
    expect(types(base({ offer: { settlementDays: 120 } }))).toContain("settlement_long");
    expect(types(base({ offer: { depositCents: 1_000_000 } }))).toContain("deposit_low");
    expect(types(base({ offer: { conditions: ["Subject to sale of buyer's property"] } }))).toContain("subject_to_sale");
    expect(types(base({ offer: { conditions: ["Subject to finance"] }, buyer: { financed: true, verifiedPrequal: false, firstTime: true, inspectionsBooked: 1 } }))).toContain("finance_unverified");
  });
  it("suggests trading time for certainty only when there are other offers", () => {
    const f = base({ offer: { settlementDays: 60 } });
    expect(types(f)).not.toContain("settlement_flex_trade");
    expect(types({ ...f, seller: { otherOffers: 2, daysOnMarket: 5 } })).toContain("settlement_flex_trade");
  });
  it("suggests a price compromise only for a low offer on a stale listing", () => {
    expect(types(base({ offer: { priceCents: 85_000_000 }, seller: { otherOffers: 0, daysOnMarket: 90 } }))).toContain("price_gap_compromise");
    expect(types(base({ offer: { priceCents: 85_000_000 } }))).not.toContain("price_gap_compromise");
  });
  it("never coaches rentals", () => { expect(allSuggestions(base({ transactionType: "rent", offer: { settlementDays: 3, conditions: [] } }))).toEqual([]); });

  it("shows each side only its own audience, most serious first", () => {
    const f = base({ offer: { settlementDays: 30, conditions: ["Subject to finance"], depositCents: 1_000_000 }, buyer: { financed: true, verifiedPrequal: false, firstTime: true, inspectionsBooked: 0 }, seller: { otherOffers: 2, daysOnMarket: 5 } });
    const seller = suggestionsFor(f), buyer = suggestionsFor({ ...f, side: "buyer" }), agent = suggestionsFor({ ...f, side: "agent" });
    expect(seller.map(s => s.type)).toEqual(agent.map(s => s.type));
    expect(seller.map(s => s.type)).toContain("finance_unverified");
    expect(seller.map(s => s.type)).toContain("deposit_low");
    expect(buyer.map(s => s.type)).not.toContain("finance_unverified");
    expect(buyer.map(s => s.type)).not.toContain("deposit_low");
    expect(buyer.map(s => s.type)).toContain("finance_timeline_tight");
    expect(seller.map(s => s.type)).not.toContain("finance_timeline_tight");
    const ranks = seller.map(s => ["risk", "caution", "info"].indexOf(s.severity));
    expect([...ranks].sort()).toEqual(ranks);
  });
  it("never mentions other offers to the buyer", () => {
    const f = base({ side: "buyer", offer: { settlementDays: 60 }, seller: { otherOffers: 3, daysOnMarket: 5 } });
    expect(JSON.stringify(suggestionsFor(f))).not.toMatch(/other offers/i);
  });
  it("only coaches while the deal can still change", () => {
    expect(coachingActive("deposit_received", false, false)).toBe(true);
    expect(coachingActive("lawyer_exchange", false, false)).toBe(true);
    expect(coachingActive("settlement_scheduled", false, false)).toBe(false);
    expect(coachingActive("deposit_received", true, false)).toBe(false);
    expect(coachingActive("deposit_received", false, true)).toBe(false);
  });
  it("compares with similar settled deals only when there are enough", () => {
    const s = (terms: number, days: number) => ({ terms, days });
    expect(compareHistory(42, [s(40, 40), s(45, 44)])).toBeNull();
    const c = compareHistory(42, [s(40, 38), s(41, 40), s(45, 44), s(42, 46), s(50, 50), s(90, 200)]);
    expect(c).toMatchObject({ sampleSize: 5, medianDays: 44 });
    expect(c!.text).toContain("44 days");
  });
});
