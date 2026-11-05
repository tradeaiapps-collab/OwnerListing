import { describe, expect, it } from "vitest";
import { parseComparables, type Comparable } from "../src/domain/price-guidance";
import {
  findComparableProperties, intelAnswer, marketInsights, marketReport, parseIntelQuery, valueProperty, valueTrend, type IntelBundle, type IntelQuery
} from "../src/domain/property-intelligence";

const NOW = "2026-11-05T00:00:00.000Z";
let n = 0;
const monthsAgo = (m: number) => new Date(Date.parse(NOW) - m * 30.44 * 86_400_000).toISOString();
const comp = (o: Partial<Comparable> = {}): Comparable => ({
  id: `c${++n}`, transactionType: "sale", propertyType: "house", priceCents: 120_000_000, date: monthsAgo(1), suburb: "Paddington", postcode: "4064",
  bedrooms: 3, bathrooms: 2, parking: 1, ...o
});
const q: IntelQuery = { transactionType: "sale", propertyType: "house", suburb: "Paddington", postcode: "4064", bedrooms: 3, bathrooms: 2, parking: 1 };
/** 24 months of sales, price rising about 1% a month, 3 a month, with days on market. */
const history = (): Comparable[] => {
  const out: Comparable[] = [];
  for (let m = 0; m < 24; m++) for (let k = 0; k < 3; k++) out.push(comp({ priceCents: Math.round(130_000_000 * (1 - 0.01 * m) * (1 + (k - 1) * 0.02)), date: monthsAgo(m + k * 0.2), daysOnMarket: 30 + k * 10 }));
  return out;
};

describe("parseIntelQuery", () => {
  const get = (o: Record<string, string>) => (k: string) => o[k] ?? null;
  it("needs a suburb or a postcode and defaults to a house for sale", () => {
    expect(parseIntelQuery(get({})).ok).toBe(false);
    expect(parseIntelQuery(get({ suburb: "Paddington" }))).toEqual({ ok: true, query: { transactionType: "sale", propertyType: "house", suburb: "Paddington" } });
  });
  it("refuses bad values with a message and never guesses", () => {
    for (const bad of [{ transactionType: "lease" }, { propertyType: "castle" }, { postcode: "40" }, { bedrooms: "-1" }, { bedrooms: "2.5" }, { areaSqm: "0" }, { condition: "ruined" }]) {
      expect(parseIntelQuery(get({ suburb: "X", ...bad })).ok).toBe(false);
    }
  });
  it("reads numbers and condition", () => {
    expect(parseIntelQuery(get({ postcode: "4064", bedrooms: "3", areaSqm: "450.4", condition: "fair" }))).toMatchObject({ ok: true, query: { bedrooms: 3, areaSqm: 450, condition: "fair" } });
  });
});

describe("valueProperty (AVM)", () => {
  const five = [115, 118, 120, 122, 126].map(p => comp({ priceCents: p * 1_000_000 }));
  it("gives a range around the middle with a confidence label and the steps", () => {
    const v = valueProperty(q, five, NOW)!;
    expect(v.midCents).toBe(120_000_000);
    expect(v.lowCents).toBeLessThan(v.midCents);
    expect(v.highCents).toBeGreaterThan(v.midCents);
    expect(v.confidenceLabel).toMatch(/good|fair/);
    expect(v.methodology.length).toBe(6);
    expect(v.modelVersion).toBe("avm-v1");
  });
  it("is deterministic and undefined (never a guess) with too little data", () => {
    expect(valueProperty(q, five, NOW)).toEqual(valueProperty(q, five, NOW));
    expect(valueProperty(q, five.slice(0, 2), NOW)).toBeUndefined();
    expect(valueProperty(q, [], NOW)).toBeUndefined();
  });
  it("condition moves the figures, excellent above typical above poor", () => {
    const v = (condition: IntelQuery["condition"]) => valueProperty({ ...q, ...(condition ? { condition } : {}) }, five, NOW)!.midCents;
    expect(v("excellent")).toBeGreaterThan(v(undefined));
    expect(v("poor")).toBeLessThan(v(undefined));
    expect(v("good")).toBe(v(undefined));
  });
  it("adjusts for size: a bigger block than the comparables lifts the estimate", () => {
    const sized = five.map(c => ({ ...c, areaSqm: 400 }));
    const base = valueProperty({ ...q, areaSqm: 400 }, sized, NOW)!;
    const bigger = valueProperty({ ...q, areaSqm: 700 }, sized, NOW)!;
    expect(bigger.midCents).toBeGreaterThan(base.midCents);
    expect(bigger.factors.sizeAdjusted).toBe(true);
    expect(valueProperty(q, sized, NOW)!.factors.sizeAdjusted).toBe(false);
  });
  it("ignores other areas, other transaction types and sales after today", () => {
    const noise = [comp({ suburb: "Elsewhere", postcode: "9999" }), comp({ transactionType: "rent" }), comp({ date: "2027-01-01T00:00:00.000Z" })];
    expect(valueProperty(q, noise, NOW)).toBeUndefined();
  });
});

describe("marketInsights", () => {
  it("is unavailable with fewer than five sales in the last year", () => {
    const m = marketInsights(q, [comp(), comp(), comp(), comp()], NOW);
    expect(m).toMatchObject({ state: "unavailable", sampleSize: 4 });
  });
  it("reports median, pace, days on market and the year on year move", () => {
    const m = marketInsights(q, history(), NOW);
    if (m.state !== "ready") throw new Error("expected ready");
    expect(m.sampleSize).toBeGreaterThanOrEqual(30);
    expect(m.p25Cents).toBeLessThanOrEqual(m.medianCents);
    expect(m.p75Cents).toBeGreaterThanOrEqual(m.medianCents);
    expect(m.medianDaysOnMarket).toBe(40);
    expect(m.change12mPercent).toBeGreaterThan(5);
    expect(m.salesPerMonth).toBeGreaterThan(2);
    expect(m.velocity).toBe("steady");
  });
  it("calls the market heating or cooling from the sales pace", () => {
    const recent = (a: number, b: number) => [...Array.from({ length: a }, () => comp({ date: monthsAgo(1) })), ...Array.from({ length: b }, () => comp({ date: monthsAgo(4) })), ...Array.from({ length: 3 }, () => comp({ date: monthsAgo(8) }))];
    expect((marketInsights(q, recent(12, 4), NOW) as { velocity?: string }).velocity).toBe("heating");
    expect((marketInsights(q, recent(3, 10), NOW) as { velocity?: string }).velocity).toBe("cooling");
  });
  it("leaves out days on market when too few dates are known", () => {
    const m = marketInsights(q, Array.from({ length: 8 }, () => comp()), NOW);
    expect(m).toMatchObject({ state: "ready", daysOnMarketSample: 0 });
    expect((m as { medianDaysOnMarket?: number }).medianDaysOnMarket).toBeUndefined();
  });
});

describe("valueTrend", () => {
  it("draws a rolling median that follows the rise", () => {
    const t = valueTrend(q, history(), NOW, 24);
    if (t.state !== "ready") throw new Error("expected ready");
    expect(t.points.length).toBeGreaterThan(12);
    expect(t.points[0]!.month < t.points[t.points.length - 1]!.month).toBe(true);
    expect(t.changePercent).toBeGreaterThan(5);
    expect(t.points.every(p => p.count >= 3)).toBe(true);
  });
  it("is unavailable without history", () => {
    expect(valueTrend(q, [comp(), comp()], NOW)).toMatchObject({ state: "unavailable" });
  });
});

describe("findComparableProperties", () => {
  it("returns the most alike, newest first, with a match score and an adjusted price", () => {
    const rows = findComparableProperties(q, [comp({ bedrooms: 3, date: monthsAgo(1) }), comp({ bedrooms: 5, date: monthsAgo(1) }), comp({ bedrooms: 3, date: monthsAgo(10) })], NOW, 10);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ bedrooms: 3, similarity: 100 });
    expect(rows[0]!.similarity).toBeGreaterThanOrEqual(rows[2]!.similarity);
    expect(rows[1]!.adjustedCents).toBeGreaterThan(0);
  });
  it("respects the limit, the 12 month window and the area", () => {
    const many = Array.from({ length: 30 }, () => comp());
    expect(findComparableProperties(q, many, NOW, 5)).toHaveLength(5);
    expect(findComparableProperties(q, [comp({ date: monthsAgo(14) }), comp({ suburb: "Elsewhere", postcode: "9999" })], NOW)).toEqual([]);
  });
});

const bundle = (comps: Comparable[]): IntelBundle => ({
  query: q, valuation: valueProperty(q, comps, NOW), market: marketInsights(q, comps, NOW), trend: valueTrend(q, comps, NOW), comparables: findComparableProperties(q, comps, NOW)
});

describe("Elena's answers (intelAnswer)", () => {
  const b = bundle(history());
  it("explains the method with the same numbers as the valuation", () => {
    const a = intelAnswer(b, "How was this value worked out?");
    expect(a.topic).toBe("methodology");
    expect(a.text).toContain(`$${Math.round(b.valuation!.midCents / 100).toLocaleString("en-AU")}`);
    expect(a.text).toMatch(/can't change them/);
  });
  it("explains confidence and the interval", () => {
    const a = intelAnswer(b, "How confident are you in the range?");
    expect(a.topic).toBe("confidence");
    expect(a.text).toContain(`${b.valuation!.intervalPercent}%`);
    expect(a.text).toMatch(/not a formal valuation/);
  });
  it("covers trends, market, comparables and the report", () => {
    expect(intelAnswer(b, "What are the market trends?").topic).toBe("trends");
    expect(intelAnswer(b, "How long do homes take to sell, what's the demand?").topic).toBe("market");
    expect(intelAnswer(b, "Show me similar recent sales").topic).toBe("comparables");
    const r = intelAnswer(b, "Write me a market report");
    expect(r.topic).toBe("report");
    expect(r.text).toContain("Market report: Paddington 4064");
    expect(r.text).toMatch(/not a valuation/);
  });
  it("gives no advice and no figures it does not have", () => {
    expect(intelAnswer(b, "Should I sell now?").topic).toBe("advice");
    const empty = bundle([]);
    expect(intelAnswer(empty, "how was it calculated").text).toMatch(/too few recent comparable/);
    expect(intelAnswer(empty, "trends").text).not.toMatch(/\$\d/);
    expect(intelAnswer(empty, "market").text).toMatch(/not enough/);
    expect(intelAnswer(b, "banana").topic).toBe("unknown");
  });
  it("marketReport says so when there is no data, and notes low confidence", () => {
    const r = marketReport(bundle([]));
    expect(r.sections.map(s => s.heading)).toEqual(["Estimated value", "Market", "Value trend"]);
    const wide = marketReport(bundle([80, 100, 120, 140, 160, 90, 150].map(p => comp({ priceCents: p * 1_000_000 }))));
    expect(wide.considerations.join(" ")).toMatch(/wide|handful/);
  });
});

describe("parseComparables keeps the new optional fields", () => {
  it("accepts areaSqm and daysOnMarket and drops bad values", () => {
    const base = { id: "a", transactionType: "sale", propertyType: "house", priceCents: 1, date: "2026-01-01", suburb: "X" };
    expect(parseComparables([{ ...base, areaSqm: 450, daysOnMarket: 21 }])[0]).toMatchObject({ areaSqm: 450, daysOnMarket: 21 });
    const bad = parseComparables([{ ...base, areaSqm: -5, daysOnMarket: 1.5 }])[0]!;
    expect(bad.areaSqm).toBeUndefined();
    expect(bad.daysOnMarket).toBeUndefined();
  });
});
