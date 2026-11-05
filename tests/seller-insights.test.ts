import { describe, expect, it } from "vitest";
import type { Comparable } from "../src/domain/price-guidance";
import {
  comparableSales, daysAtPrice, daysOnMarket, FAST_SALE_DISCOUNT, priceCurve, priceDaysModel, pricingAdvice, sellerBundle, sellerTrend
} from "../src/domain/seller-insights";

const NOW = "2026-11-05T00:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
const subject = { transactionType: "sale" as const, propertyType: "house", suburb: "Paddington", postcode: "4064", bedrooms: 3 };
const comp = (i: number, daysBack: number, cents: number, extra: Partial<Comparable> = {}): Comparable =>
  ({ id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: cents, date: daysAgo(daysBack), suburb: "Paddington", postcode: "4064", bedrooms: 3, ...extra });
// 12 sales in the last 90 days: price 100m..122m cents (in cents: $1.0m to $1.22m); days to sell rise with price.
const recent = Array.from({ length: 12 }, (_, i) => comp(i, 5 + i * 7, 100_000_000 + i * 2_000_000, { areaSqm: 500, daysOnMarket: 8 + i * 3 }));
const earlier = Array.from({ length: 4 }, (_, i) => comp(100 + i, 100 + i * 15, 90_000_000 + i * 1_000_000, { daysOnMarket: 30 }));

describe("comparable sales", () => {
  it("uses only sales in the last 90 days, and compares with the quarter before", () => {
    const c = comparableSales(subject, [...recent, ...earlier, comp(999, 200, 1)], NOW);
    expect(c.state).toBe("ready");
    if (c.state !== "ready") return;
    expect(c.count).toBe(12);
    expect(c.medianCents).toBe(111_000_000);
    expect(c.p25Cents).toBeLessThan(c.medianCents);
    expect(c.p75Cents).toBeGreaterThan(c.medianCents);
    expect(c.direction).toBe("up");
    expect(c.changeVsLastQuarterPercent).toBeGreaterThan(10);
    expect(c.medianPricePerSqmCents).toBe(Math.round(111_000_000 / 500));
    expect(c.insight).toMatch(/Properties like yours are selling for \$[\d,]+ to \$[\d,]+/);
  });
  it("leaves out other types, rentals, other suburbs and very different sizes", () => {
    const odd = [
      comp(200, 10, 5_000_000, { propertyType: "unit" }), comp(201, 10, 5_000_000, { transactionType: "rent" }),
      comp(202, 10, 5_000_000, { suburb: "Elsewhere", postcode: "9999" }), comp(203, 10, 5_000_000, { areaSqm: 2000 })
    ];
    const c = comparableSales({ ...subject, areaSqm: 500 }, [...recent, ...odd], NOW);
    expect(c.state === "ready" && c.count).toBe(12);
  });
  it("says unavailable instead of guessing with fewer than three sales", () => {
    expect(comparableSales(subject, recent.slice(0, 2), NOW).state).toBe("unavailable");
    expect(comparableSales(subject, [], NOW).state).toBe("unavailable");
  });
});

describe("price trend and season", () => {
  const monthly = Array.from({ length: 24 }, (_, i) => comp(300 + i, 10 + i * 15, 100_000_000 + (23 - i) * 500_000 + (i % 2) * 1_000_000));
  it("averages by month and reports year on year and the current season", () => {
    const t = sellerTrend(subject, monthly, NOW);
    expect(t.state).toBe("ready");
    if (t.state !== "ready") return;
    expect(t.points.length).toBeGreaterThanOrEqual(10);
    expect(t.points.every(p => p.sales > 0 && p.averageCents > 0)).toBe(true);
    expect(t.points.map(p => p.month)).toEqual([...t.points.map(p => p.month)].sort());
    expect(t.season?.season).toBe("Spring");
    expect(t.insight).toMatch(/12 months/);
  });
  it("is unavailable with too few sales", () => expect(sellerTrend(subject, monthly.slice(0, 4), NOW).state).toBe("unavailable"));
});

describe("days on the market and the price guide", () => {
  it("splits sales into fast, standard and slow", () => {
    const d = daysOnMarket(subject, recent, NOW);
    expect(d.state).toBe("ready");
    if (d.state !== "ready") return;
    expect(d.bands.fast + d.bands.standard + d.bands.slow).toBe(12);
    expect(d.bands.fast).toBe(3); // 8, 11, 14
    expect(d.bandPercent.fast + d.bandPercent.standard + d.bandPercent.slow).toBeGreaterThanOrEqual(99);
  });
  it("estimates more days at higher prices, held to the range seen", () => {
    const m = priceDaysModel(subject, recent, NOW);
    expect(m.state).toBe("ready");
    if (m.state !== "ready") return;
    expect(m.confidence).toBe("fair"); // 12 sales, a clean link: fair until 15
    expect(daysAtPrice(m, m.medianCents * 1.05)).toBeGreaterThan(daysAtPrice(m, m.medianCents * 0.95));
    expect(daysAtPrice(m, 1)).toBe(daysAtPrice(m, m.minCents));
    expect(daysAtPrice(m, 1e12)).toBe(daysAtPrice(m, m.maxCents));
    const curve = priceCurve(m, 5);
    expect(curve).toHaveLength(5);
    expect(curve[0]!.days).toBeLessThan(curve[4]!.days);
  });
  it("refuses a backwards or missing link rather than drawing one", () => {
    const backwards = recent.map((c, i) => ({ ...c, daysOnMarket: 60 - i * 3 }));
    expect(priceDaysModel(subject, backwards, NOW).state).toBe("unavailable");
    expect(priceDaysModel(subject, recent.slice(0, 5), NOW).state).toBe("unavailable");
    expect(priceDaysModel(subject, recent.map(c => ({ ...c, priceCents: 100_000_000 })), NOW).state).toBe("unavailable");
  });
});

describe("pricing advice", () => {
  it("fast sale is 10% under the median, max price is the upper quartile, balanced the median", () => {
    const fast = pricingAdvice("fast_sale", subject, recent, NOW), max = pricingAdvice("max_price", subject, recent, NOW), bal = pricingAdvice("balanced", subject, recent, NOW);
    if (fast.state !== "ready" || max.state !== "ready" || bal.state !== "ready") throw new Error("expected ready");
    expect(Math.abs(fast.recommendedCents - 111_000_000 * (1 - FAST_SALE_DISCOUNT))).toBeLessThanOrEqual(250_000);
    expect(bal.recommendedCents).toBe(111_000_000);
    expect(max.recommendedCents).toBeGreaterThan(bal.recommendedCents);
    expect(fast.recommendedCents).toBeLessThan(bal.recommendedCents);
    expect(fast.scenarios).toHaveLength(3);
    expect(fast.scenarios[0]!.estimatedDays).toBeLessThan(max.scenarios[1]!.estimatedDays!);
    expect(fast.rationale).toMatch(/sell fast/i);
    expect(fast.rationale.length).toBeLessThanOrEqual(1000);
  });
  it("still advises on price when days cannot be estimated, and says so", () => {
    const noDays = recent.map(c => { const { daysOnMarket: _d, ...rest } = c; return rest; });
    const a = pricingAdvice("balanced", subject, noDays, NOW);
    expect(a.state === "ready" && a.scenarios.every(s => s.estimatedDays === undefined)).toBe(true);
    expect(a.state === "ready" && a.rationale).toMatch(/could not be estimated/);
  });
  it("gives no price without enough sales", () => expect(pricingAdvice("fast_sale", subject, recent.slice(0, 2), NOW).state).toBe("unavailable"));
  it("the bundle always carries the guide-only note", () => expect(sellerBundle(subject, [], NOW).note).toMatch(/not a valuation/));
});
