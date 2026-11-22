import { describe, expect, it } from "vitest";
import type { Comparable } from "../src/domain/price-guidance";
import { buildPriceSuggestion, landFactor, type AskingListing, type SuggestionSubject } from "../src/domain/price-suggestion";

const now = "2026-11-20T00:00:00.000Z";
const subject: SuggestionSubject = { transactionType: "sale", propertyType: "house", suburb: "Paddington", postcode: "4064", bedrooms: 3, bathrooms: 2, parking: 1 };
const sale = (i: number, price: number, extra: Partial<Comparable> = {}): Comparable => ({
  id: `s${i}`, transactionType: "sale", propertyType: "house", priceCents: price * 100, date: "2026-10-01T00:00:00.000Z", suburb: "Paddington", postcode: "4064",
  bedrooms: 3, bathrooms: 2, parking: 1, label: `${i} Example St`, ...extra
});
const ask = (i: number, price: number): AskingListing => ({ ...sale(i, price), id: `listing:${i}`, label: "Listing in Paddington" });
const base = { subject, sales: [] as Comparable[], asking: [] as AskingListing[], now };

describe("price suggestion", () => {
  it("says insufficient, with reasons and no number, when nothing is known", () => {
    const r = buildPriceSuggestion(base);
    expect(r.state).toBe("insufficient");
    if (r.state === "insufficient") {
      expect(r.missing.join(" ")).toMatch(/No sold results/);
      expect(r.missing.join(" ")).toMatch(/No licensed sales-data provider/);
      expect(JSON.stringify(r)).not.toMatch(/lowCents/);
    }
  });
  it("uses sold results first, with evidence at original prices", () => {
    const r = buildPriceSuggestion({ ...base, sales: [sale(1, 1_100_000), sale(2, 1_150_000), sale(3, 1_200_000), sale(4, 1_180_000)], asking: [ask(9, 1_900_000), ask(8, 1_950_000), ask(7, 2_000_000)] });
    expect(r.state === "ready" && r.basis).toBe("sold_comparables");
    if (r.state === "ready") {
      expect(r.midCents).toBeGreaterThan(110_000_000);
      expect(r.highCents).toBeLessThan(130_000_000);
      expect(r.evidence.every(e => e.kind === "sold")).toBe(true);
      expect(r.evidence.map(e => e.priceCents)).toContain(115_000_000);
      expect(r.disclaimer).toMatch(/not a valuation/);
    }
  });
  it("falls back to asking prices at low confidence and says they are not sales", () => {
    const r = buildPriceSuggestion({ ...base, asking: [ask(1, 1_100_000), ask(2, 1_150_000), ask(3, 1_200_000)] });
    expect(r.state === "ready" && r.basis).toBe("asking_comparables");
    if (r.state === "ready") { expect(r.confidence).toBe("low"); expect(r.steps.join(" ")).toMatch(/not what buyers paid/); }
  });
  it("one or two comparables: low confidence, 15% either side, evidence listed", () => {
    const r = buildPriceSuggestion({ ...base, asking: [ask(1, 1_000_000)] });
    expect(r.state).toBe("ready");
    if (r.state === "ready") {
      expect(r.confidence).toBe("low");
      expect(r.lowCents).toBeLessThan(90_000_000); expect(r.highCents).toBeGreaterThan(110_000_000);
      expect(r.evidence).toHaveLength(1);
    }
  });
  it("suburb median only: low confidence, broad range, names its source", () => {
    const r = buildPriceSuggestion({ ...base, suburb: { metrics: { medianHousePrice: 120_000_000 }, source: "ABS test", asAt: "2026-06-30" } });
    expect(r.state === "ready" && r.basis).toBe("suburb_median");
    if (r.state === "ready") { expect(r.confidence).toBe("low"); expect(r.basisLabel).toMatch(/ABS test/); expect(r.evidence).toEqual([]); }
  });
  it("does not use a unit median for a house, or any median for commercial", () => {
    const m = { metrics: { medianUnitPrice: 80_000_000 }, source: "x y z", asAt: "2026-06-30" };
    expect(buildPriceSuggestion({ ...base, suburb: m }).state).toBe("insufficient");
    expect(buildPriceSuggestion({ ...base, subject: { ...subject, propertyType: "office" }, suburb: { ...m, metrics: { medianHousePrice: 1 } } }).state).toBe("insufficient");
  });
  it("a provider valuation wins and is passed through unchanged", () => {
    const r = buildPriceSuggestion({ ...base, sales: [sale(1, 1_100_000)], valuation: { provider: "avm", label: "Test AVM", value: { lowCents: 90_000_000, midCents: 95_000_000, highCents: 100_000_000, confidence: "high" } } });
    expect(r).toMatchObject({ state: "ready", basis: "provider_valuation", lowCents: 90_000_000, highCents: 100_000_000, confidence: "high" });
  });
  it("compares the owner's price with the range without changing it, and lists what is not priced in", () => {
    const sales = [sale(1, 1_100_000), sale(2, 1_150_000), sale(3, 1_200_000)];
    const above = buildPriceSuggestion({ ...base, sales, subject: { ...subject, currentPriceCents: 200_000_000, amenities: ["pool"] }, inspectionReports: 1 });
    expect(above.state === "ready" && above.position?.relation).toBe("above");
    if (above.state === "ready") { expect(above.notPricedIn.join(" ")).toMatch(/inspection/); expect(above.notPricedIn.join(" ")).toMatch(/pool/); }
    const inside = buildPriceSuggestion({ ...base, sales, subject: { ...subject, currentPriceCents: 115_000_000 } });
    expect(inside.state === "ready" && inside.position?.relation).toBe("inside");
  });
  it("land size scales gently and is limited", () => {
    expect(landFactor(undefined, 600)).toBe(1);
    expect(landFactor(1200, 600)).toBeGreaterThan(1);
    expect(landFactor(1200, 600)).toBeLessThanOrEqual(1.15);
    expect(landFactor(100_000, 600)).toBe(1.15);
    expect(landFactor(10, 600)).toBe(0.85);
  });
  it("larger land lifts the range", () => {
    const sales = [1, 2, 3].map(i => sale(i, 1_000_000 + i * 10_000, { areaSqm: 400 }));
    const small = buildPriceSuggestion({ ...base, sales, subject: { ...subject, landAreaSqm: 400 } });
    const big = buildPriceSuggestion({ ...base, sales, subject: { ...subject, landAreaSqm: 800 } });
    if (small.state !== "ready" || big.state !== "ready") throw new Error("expected ready");
    expect(big.midCents).toBeGreaterThan(small.midCents);
    expect(big.evidence[0]!.priceCents).toBe(small.evidence[0]!.priceCents);
  });
});
