import { describe, expect, it } from "vitest";
import {
  buildExtended, DEMAND_UNAVAILABLE, demandOutlook, detectMarketShifts, extendedAnswer, forecastTrend, investmentScore, marketAt, valuationBreakdown,
  type DemandFacts
} from "../src/domain/market-forecast";
import type { Comparable } from "../src/domain/price-guidance";
import { marketInsights, valueProperty, valueTrend, type IntelBundle, type IntelQuery } from "../src/domain/property-intelligence";

const NOW = "2026-11-05T00:00:00.000Z";
let n = 0;
const monthsAgo = (m: number) => new Date(Date.parse(NOW) - m * 30.44 * 86_400_000).toISOString();
const comp = (o: Partial<Comparable> = {}): Comparable => ({
  id: `c${++n}`, transactionType: "sale", propertyType: "house", priceCents: 120_000_000, date: monthsAgo(1), suburb: "Paddington", postcode: "4064",
  bedrooms: 3, bathrooms: 2, parking: 1, ...o
});
const q: IntelQuery = { transactionType: "sale", propertyType: "house", suburb: "Paddington", postcode: "4064", bedrooms: 3, bathrooms: 2, parking: 1 };
/** 24 months of sales, rising about 1% a month, 3 a month, with days on market. */
const history = (slope = 0.01, tx: "sale" | "rent" = "sale", base = 130_000_000): Comparable[] => {
  const out: Comparable[] = [];
  for (let m = 0; m < 24; m++) for (let k = 0; k < 3; k++) out.push(comp({ transactionType: tx, priceCents: Math.round(base * (1 - slope * m) * (1 + (k - 1) * 0.02)), date: monthsAgo(m + k * 0.2), daysOnMarket: 30 + k * 10 }));
  return out;
};
const bundle = (comps: Comparable[], query: IntelQuery = q): IntelBundle => ({
  query, valuation: valueProperty(query, comps, NOW), market: marketInsights(query, comps, NOW), trend: valueTrend(query, comps, NOW), comparables: []
});

describe("forecastTrend", () => {
  it("extends a rising market upward with a range that widens over the horizon", () => {
    const f = forecastTrend(valueTrend(q, history(), NOW), "sale");
    expect(f.state).toBe("ready");
    if (f.state !== "ready") return;
    expect(f.direction).toBe("rising");
    expect(f.horizons.map(h => h.months)).toEqual([3, 6, 12]);
    const [h3, h6, h12] = f.horizons as [typeof f.horizons[0], typeof f.horizons[0], typeof f.horizons[0]];
    expect(h3.midCents).toBeGreaterThan(0);
    expect(h12.midCents).toBeGreaterThan(h3.midCents);
    for (const h of f.horizons) { expect(h.lowCents).toBeLessThanOrEqual(h.midCents); expect(h.midCents).toBeLessThanOrEqual(h.highCents); }
    expect(h12.highCents - h12.lowCents).toBeGreaterThanOrEqual(h3.highCents - h3.lowCents);
    expect(h6.changePercent).toBeGreaterThan(0);
    expect(f.note).toMatch(/not a prediction/i);
  });
  it("calls a falling market falling and a flat one steady", () => {
    const down = forecastTrend(valueTrend(q, history(-0.01), NOW), "sale");
    expect(down).toMatchObject({ state: "ready", direction: "falling" });
    const flat = forecastTrend(valueTrend(q, history(0), NOW), "sale");
    expect(flat).toMatchObject({ state: "ready", direction: "steady" });
  });
  it("is unavailable, never a guess, when there is too little history", () => {
    expect(forecastTrend(valueTrend(q, [], NOW), "sale")).toMatchObject({ state: "unavailable" });
    const short = history().filter(c => Date.parse(c.date) > Date.parse(monthsAgo(4)));
    expect(forecastTrend(valueTrend(q, short, NOW), "sale").state).toBe("unavailable");
  });
  it("ignores invalid horizons", () => {
    const f = forecastTrend(valueTrend(q, history(), NOW), "sale", [0, 3, 99, 2.5]);
    expect(f.state === "ready" && f.horizons.map(h => h.months)).toEqual([3]);
  });
});

describe("valuationBreakdown", () => {
  it("steps add up to the estimate and name the heaviest comparables", () => {
    const comps = history();
    const subject = { ...q, bedrooms: 4, areaSqm: 700, condition: "excellent" as const };
    const v = valueProperty(subject, comps.map(c => ({ ...c, areaSqm: 500 })), NOW)!;
    const b = valuationBreakdown(subject, comps.map(c => ({ ...c, areaSqm: 500 })), NOW, v)!;
    expect(b.steps.map(s => s.key)).toEqual(["comparables", "features", "size", "condition"]);
    expect(b.startCents + b.steps.reduce((s, x) => s + x.deltaCents, 0)).toBe(v.midCents);
    expect(b.steps[b.steps.length - 1]!.runningCents).toBe(v.midCents);
    expect(b.steps[1]!.deltaCents).toBeGreaterThan(0); // an extra bedroom
    expect(b.steps[2]!.deltaCents).toBeGreaterThan(0); // a bigger block
    expect(b.steps[3]!.deltaCents).toBeGreaterThan(0); // excellent condition
    expect(b.topComparables.length).toBeGreaterThan(0);
    expect(b.topComparables.reduce((s, c) => s + c.sharePercent, 0)).toBeLessThanOrEqual(100);
  });
  it("shows no size or condition change when none was given", () => {
    const comps = history();
    const v = valueProperty(q, comps, NOW)!;
    const b = valuationBreakdown(q, comps, NOW, v)!;
    expect(b.steps[2]!.deltaCents).toBe(0);
    expect(b.steps[3]!.deltaCents).toBe(0);
  });
});

describe("investmentScore", () => {
  const market = (comps: Comparable[], s = q) => marketInsights(s, comps, NOW);
  it("scores growth, yield, time to sell, momentum and consistency and re-weights what is missing", () => {
    const sale = history();
    const rent = history(0.002, "rent", 70_000);
    const f = forecastTrend(valueTrend(q, sale, NOW), "sale");
    const s = investmentScore({ market: market(sale), forecast: f, rentMarket: marketInsights({ ...q, transactionType: "rent" }, rent, NOW) });
    expect(s.state).toBe("ready");
    if (s.state !== "ready") return;
    expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(100);
    expect(s.components.map(c => c.key)).toEqual(expect.arrayContaining(["growth", "yield", "liquidity", "stability"]));
    expect(s.grossYieldPercent).toBeGreaterThan(0);
    const without = investmentScore({ market: market(sale), forecast: f });
    expect(without.state === "ready" && without.components.some(c => c.key === "yield")).toBe(false);
    expect(s.note).toMatch(/not .*investment advice/i);
  });
  it("scores a rising, quick-selling market above a falling, slow one", () => {
    const up = investmentScore({ market: market(history(0.01)), forecast: forecastTrend(valueTrend(q, history(0.01), NOW), "sale") });
    const slow = history(-0.01).map(c => ({ ...c, daysOnMarket: 110 }));
    const down = investmentScore({ market: market(slow), forecast: forecastTrend(valueTrend(q, slow, NOW), "sale") });
    expect(up.state === "ready" && down.state === "ready" && up.score > down.score).toBe(true);
  });
  it("is unavailable when the market has too few results", () => {
    expect(investmentScore({ market: market([comp(), comp()]) }).state).toBe("unavailable");
  });
});

describe("demandOutlook", () => {
  const facts = (series: number[], active = 4): DemandFacts => ({ weeks: series.map(e => ({ saves: e * 2, enquiries: e, offers: 0 })), activeListings: active });
  it("reads rising, steady and easing interest and projects four weeks with a range", () => {
    const up = demandOutlook(facts([2, 3, 3, 5, 6, 8, 9, 12]));
    expect(up).toMatchObject({ state: "ready", outlook: "rising" });
    if (up.state === "ready") { expect(up.recentChangePercent).toBeGreaterThan(40); expect(up.next4Weeks.lowActivity).toBeLessThanOrEqual(up.next4Weeks.midActivity); expect(up.next4Weeks.midActivity).toBeLessThanOrEqual(up.next4Weeks.highActivity); }
    expect(demandOutlook(facts([6, 6, 6, 6, 6, 6, 6, 6]))).toMatchObject({ state: "ready", outlook: "steady" });
    expect(demandOutlook(facts([12, 10, 9, 7, 6, 4, 3, 2]))).toMatchObject({ state: "ready", outlook: "easing" });
  });
  it("hides itself when activity or history is too thin, so small areas cannot be read", () => {
    expect(demandOutlook(facts([0, 0, 1, 0, 0, 0, 0, 0]))).toEqual({ state: "unavailable", message: DEMAND_UNAVAILABLE });
    expect(demandOutlook(facts([5, 5, 5]))).toMatchObject({ state: "unavailable" });
  });
});

describe("detectMarketShifts", () => {
  const rising = history(0.012);
  it("reports a notable price move with its figures, and nothing for a calm market", () => {
    const now = marketInsights(q, rising, NOW);
    const shifts = detectMarketShifts({ area: "Paddington houses", now });
    expect(shifts.some(s => s.kind === "prices_up")).toBe(true);
    expect(shifts[0]!.text).toMatch(/\d/);
    expect(detectMarketShifts({ area: "Calm", now: marketInsights(q, history(0), NOW), before: marketAt(q, history(0), NOW, 1) })).toEqual([]);
  });
  it("flags activity turning, slower sales and a buyer-interest swing, once each", () => {
    const base = history(0);
    const fewer = base.filter(c => Date.parse(c.date) < Date.parse(monthsAgo(3)) || Date.parse(c.date) > Date.parse(monthsAgo(2)));
    const now = marketInsights(q, fewer.map(c => ({ ...c, daysOnMarket: 60 })), NOW);
    const before = marketInsights(q, base, NOW);
    const demand = demandOutlook({ weeks: [2, 2, 3, 3, 8, 9, 10, 12].map(e => ({ saves: e, enquiries: e, offers: 0 })), activeListings: 3 });
    const shifts = detectMarketShifts({ area: "Paddington houses", now, before, demand });
    const kinds = shifts.map(s => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toEqual(expect.arrayContaining(["slower_sales", "demand_up"]));
  });
  it("says nothing when the area has too little data", () => {
    expect(detectMarketShifts({ area: "X", now: marketInsights(q, [comp()], NOW) })).toEqual([]);
  });
});

describe("Elena's extended answers", () => {
  const comps = history();
  const b = bundle(comps);
  const x = buildExtended(q, [...comps, ...history(0.002, "rent", 70_000)], NOW, b, { weeks: [2, 3, 3, 5, 6, 8, 9, 12].map(e => ({ saves: e, enquiries: e, offers: 1 })), activeListings: 4 });
  it("answers forecast, fundamentals, demand and breakdown questions from the figures", () => {
    expect(extendedAnswer(b, x, "Where are prices heading?").text).toMatch(/12 months: about \$/);
    expect(extendedAnswer(b, x, "How strong are the area fundamentals?").text).toMatch(/\d+\/100/);
    expect(extendedAnswer(b, x, "How is buyer demand?").text).toMatch(/rising|steady|easing/);
    expect(extendedAnswer(b, x, "What drove this value?").text).toMatch(/starts from/);
  });
  it("falls back to the first-layer answers for everything else", () => {
    expect(extendedAnswer(b, x, "How confident is the estimate?").topic).toBe("confidence");
    expect(extendedAnswer(b, x, "Show me the comparable sales").topic).toBe("comparables");
  });
  it("will not promise or advise", () => {
    for (const ask of ["Will prices rise next year?", "Should I buy now?", "Is it a safe bet?", "Guarantee me growth", "Is this a good investment?"]) {
      expect(extendedAnswer(b, x, ask).text).toMatch(/can't|cannot|nobody/i);
    }
  });
  it("says so plainly when data is missing", () => {
    const empty = bundle([]);
    const xe = buildExtended(q, [], NOW, empty);
    expect(extendedAnswer(empty, xe, "Where are prices heading?").text).toMatch(/not enough/);
    expect(extendedAnswer(empty, xe, "How is buyer demand?").text).toMatch(/don't have buyer activity/);
    expect(extendedAnswer(empty, xe, "What drove this value?").text).toMatch(/too few/);
  });
});
