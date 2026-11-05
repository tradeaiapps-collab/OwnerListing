import { describe, expect, it } from "vitest";
import type { Comparable } from "../src/domain/price-guidance";
import { comparableSales, pricingGuideModel, sellerBundle } from "../src/domain/seller-insights";
import {
  bandFor, DEFAULT_VALUATION_SETTINGS, parseOverride, parseValuationSettings, renovationPotential, rentalYield, valuate, valuationVisible
} from "../src/domain/valuation";

const NOW = "2026-11-05T00:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
const subject = { transactionType: "sale" as const, propertyType: "house", suburb: "Paddington", postcode: "4064", bedrooms: 3 };
const comp = (i: number, back: number, cents: number, extra: Partial<Comparable> = {}): Comparable =>
  ({ id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: cents, date: daysAgo(back), suburb: "Paddington", postcode: "4064", bedrooms: 3, ...extra });
// 12 sales, $1.00m to $1.22m, median $1.11m.
const sales = Array.from({ length: 12 }, (_, i) => comp(i, 5 + i * 7, 100_000_000 + i * 2_000_000, { daysOnMarket: 8 + i * 3 }));
const MEDIAN = 111_000_000;
const run = (asking: number | undefined, all = sales, settings = DEFAULT_VALUATION_SETTINGS, amenities: string[] = []) => {
  const b = sellerBundle(subject, all, NOW);
  return valuate({ askingCents: asking, propertyType: "house", amenities, comps: comparableSales(subject, all, NOW), priceDays: pricingGuideModel(b.pricingGuide), settings });
};

describe("price bands", () => {
  it("is underpriced under 90% of the middle, fair to 105%, a slight premium to 110%, overpriced above", () => {
    expect(bandFor(MEDIAN * 0.89, MEDIAN)).toBe("underpriced");
    expect(bandFor(MEDIAN * 0.9, MEDIAN)).toBe("fair");
    expect(bandFor(MEDIAN * 1.05, MEDIAN)).toBe("fair");
    expect(bandFor(MEDIAN * 1.07, MEDIAN)).toBe("slight_premium");
    expect(bandFor(MEDIAN * 1.1, MEDIAN)).toBe("slight_premium");
    expect(bandFor(MEDIAN * 1.11, MEDIAN)).toBe("overpriced");
  });
});

describe("valuate", () => {
  it("states the fair range as the median plus or minus 10% and where the asking price sits", () => {
    const v = run(114_000_000);
    expect(v.state).toBe("ready");
    if (v.state !== "ready") return;
    expect(v.medianCents).toBe(MEDIAN);
    expect(v.lowCents).toBe(100_000_000);
    expect(v.highCents).toBe(122_000_000);
    expect(v.differencePercent).toBe(2.7);
    expect(v.band).toBe("fair");
    expect(v.tone).toBe("green");
    expect(v.summary).toMatch(/2\.7% above the middle of recent sales/);
    expect(v.comparables.length).toBeLessThanOrEqual(8);
    expect(v.saleSpeed).toMatch(/days to sell/);
  });
  it("marks an expensive listing overpriced in red and a cheap one underpriced", () => {
    const hi = run(140_000_000), lo = run(90_000_000);
    expect(hi.state === "ready" && [hi.band, hi.tone]).toEqual(["overpriced", "red"]);
    expect(lo.state === "ready" && lo.band).toBe("underpriced");
  });
  it("says unavailable under the minimum number of sales (default 8, adjustable) and with no asking price", () => {
    expect(run(111_000_000, sales.slice(0, 7)).state).toBe("unavailable");
    expect(run(111_000_000, sales.slice(0, 7), { ...DEFAULT_VALUATION_SETTINGS, minComps: 5, highConfidenceComps: 12 }).state).toBe("ready");
    expect(run(undefined).state).toBe("unavailable");
    expect(run(111_000_000, []).state).toBe("unavailable");
  });
  it("reads High only with enough sales close together, else Medium", () => {
    const hi = run(111_000_000), few = run(111_000_000, sales.slice(0, 9));
    expect(hi.state === "ready" && hi.confidence).toBe("high");
    expect(few.state === "ready" && few.confidence).toBe("medium");
  });
});

describe("renovation and rental", () => {
  it("lists only upgrades the home lacks, and caps the uplift at 25% of the middle price", () => {
    const r = renovationPotential("house", ["garden", "solar"], MEDIAN)!;
    expect(r.items.map(i => i.key)).toEqual(["kitchen", "bathroom", "deck", "air_conditioning"]);
    expect(renovationPotential("unit", [], MEDIAN)!.items.map(i => i.key)).not.toContain("deck");
    expect(renovationPotential("house", [], 1_000_000)!.totalValueAddCents).toBe(250_000);
    expect(renovationPotential("land", [], MEDIAN)).toBeUndefined();
  });
  it("works out a gross yield from three or more recent rentals, never a guess", () => {
    const rents = [0, 1, 2].map(i => comp(50 + i, 20, 60_000 + i * 5_000, { transactionType: "rent" }));
    const y = rentalYield(subject, rents, 120_000_000, NOW)!;
    expect(y.medianWeeklyRentCents).toBe(65_000);
    expect(y.grossYieldPercent).toBe(2.8);
    expect(rentalYield(subject, rents.slice(0, 2), 120_000_000, NOW)).toBeUndefined();
  });
});

describe("switches and input", () => {
  it("is visible only when the site switch is on and the listing is not turned off", () => {
    expect(valuationVisible({ enabled: false })).toBe(false);
    expect(valuationVisible({ enabled: false }, { enabled: true })).toBe(false);
    expect(valuationVisible({ enabled: true })).toBe(true);
    expect(valuationVisible({ enabled: true }, { enabled: false })).toBe(false);
    expect(valuationVisible({ enabled: true }, { enabled: true })).toBe(true);
  });
  it("validates settings and overrides", () => {
    const d = DEFAULT_VALUATION_SETTINGS;
    expect(parseValuationSettings({ enabled: true }, d)).toEqual({ ok: true, value: { ...d, enabled: true } });
    for (const bad of [{ minComps: 2 }, { minComps: 51 }, { minComps: 8.5 }, { minComps: "8" }, { enabled: "yes" }, { minComps: 20 }]) expect(parseValuationSettings(bad, d).ok).toBe(false);
    expect(parseOverride({ enabled: false, reason: "Seller disputes the data" })).toEqual({ ok: true, enabled: false, reason: "Seller disputes the data" });
    expect(parseOverride({ enabled: false }).ok).toBe(false);
    expect(parseOverride({ enabled: null })).toEqual({ ok: true, enabled: null, reason: "" });
    expect(parseOverride({ enabled: "no", reason: "xx" }).ok).toBe(false);
  });
  it("is off by default", () => expect(DEFAULT_VALUATION_SETTINGS.enabled).toBe(false));
});
