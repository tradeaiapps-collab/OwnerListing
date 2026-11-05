import { describe, expect, it } from "vitest";
import {
  buildHeatmap, elenaAdvice, fillDays, marketComparison, priceElasticity, selectComparables, totalsFor, trendOf, windowStats,
  type CandidateListing, type DayPoint, type Subject
} from "../src/domain/listing-performance";

const NOW = "2026-11-05T10:00:00.000Z";
const day = (ago: number) => new Date(Date.parse("2026-11-05") - ago * 86_400_000).toISOString().slice(0, 10);
const pts = (n: number, f: (ago: number) => Partial<DayPoint>): DayPoint[] => Array.from({ length: n }, (_, i) => ({ date: day(i), views: 0, inquiries: 0, offers: 0, ...f(i) }));
const cand = (i: number, o: Partial<CandidateListing> = {}): CandidateListing => ({ id: `c${i}`, propertyType: "house", suburb: "Paddington", postcode: "4064", priceCents: 100_000_000 + i * 1_000_000, bedrooms: 3, ageDays: 40, views30: 60 + i * 6, inquiries30: 6, offers30: 1, ...o });
const subject: Subject = { id: "me", propertyType: "house", suburb: "paddington", postcode: "4064", priceCents: 110_000_000, bedrooms: 3 };

describe("performance calculations", () => {
  it("sums views, inquiries and offers over 7/30/90-day windows and works out rates", () => {
    const points = pts(40, () => ({ views: 3, inquiries: 1 }));
    points[2]!.offers = 1;
    const w = windowStats(points, NOW, day(39));
    const w7 = w.find(x => x.days === 7)!, w30 = w.find(x => x.days === 30)!, w90 = w.find(x => x.days === 90)!;
    expect([w7.views, w30.views, w90.views]).toEqual([21, 90, 120]);
    expect(w30.inquiries).toBe(30);
    expect(w30.inquiryRatePct).toBe(33.3);
    expect(w30.offers).toBe(1);
    expect(w30.offersPer100Views).toBe(1.1);
    expect(w30.viewsPerDay).toBe(3);
  });
  it("does not show rates under 20 views, and divides by days live for a young listing", () => {
    const t = totalsFor(pts(3, () => ({ views: 5 })), "2026-11-05", 30, 3);
    expect(t.views).toBe(15);
    expect(t.viewsPerDay).toBe(5);
    expect(t.inquiryRatePct).toBeNull();
    expect(t.offersPer100Views).toBeNull();
  });
  it("trend compares with the previous period and stays unknown for a thin or missing one", () => {
    expect(trendOf(60, 40)).toEqual({ changePct: 50, direction: "up" });
    expect(trendOf(30, 60)).toEqual({ changePct: -50, direction: "down" });
    expect(trendOf(52, 50).direction).toBe("flat");
    expect(trendOf(10, 3)).toEqual({ changePct: null, direction: "unknown" });
    const young = windowStats(pts(5, () => ({ views: 10 })), NOW, day(4));
    expect(young.every(w => w.trend.direction === "unknown")).toBe(true);
    const old = windowStats(pts(60, i => ({ views: i < 30 ? 6 : 4 })), NOW, day(59));
    expect(old.find(w => w.days === 30)!.trend).toEqual({ changePct: 50, direction: "up" });
  });
  it("fills quiet days with zeros so a chart has no gaps", () => {
    const f = fillDays([{ date: day(1), views: 4, inquiries: 0, offers: 0 }], NOW, 3);
    expect(f.map(p => p.date)).toEqual([day(2), day(1), day(0)]);
    expect(f.map(p => p.views)).toEqual([0, 4, 0]);
  });
});

describe("comparable selection and market comparison", () => {
  it("keeps same group, same suburb, price within 20%, never the listing itself; closest price first, at most five", () => {
    const all = [
      cand(1, { priceCents: 108_000_000 }), cand(2, { priceCents: 111_000_000 }), cand(3, { priceCents: 140_000_000 }), // too dear
      cand(4, { propertyType: "unit", priceCents: 110_000_000 }), cand(5, { suburb: "Toowong" }), cand(6, { id: "me" }),
      ...[7, 8, 9, 10, 11].map(i => cand(i, { priceCents: 112_000_000 + i * 100_000 }))
    ];
    const picked = selectComparables(subject, all).map(c => c.id);
    expect(picked).toHaveLength(5);
    expect(picked[0]).toBe("c2");
    for (const bad of ["c3", "c4", "c5", "me"]) expect(picked).not.toContain(bad);
  });
  it("is unavailable under three comparables and anonymises the rows", () => {
    expect(marketComparison(subject, undefined, [cand(1), cand(2)]).state).toBe("unavailable");
    const m = marketComparison(subject, undefined, [cand(1), cand(2), cand(3)]);
    if (m.state !== "ready") throw new Error("expected ready");
    expect(m.rows.map(r => r.label)).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(m.rows)).not.toContain("c1");
    expect(m.average.medianAskingCents).toBe(102_000_000);
  });
  it("gaps compare the seller's 30-day figures with the average", () => {
    const comps = [cand(1, { views30: 90 }), cand(2, { views30: 90 }), cand(3, { views30: 90 })]; // 3 views a day each
    const mine = totalsFor(pts(30, () => ({ views: 2 })), "2026-11-05", 30, 40);
    const m = marketComparison(subject, mine, comps);
    if (m.state !== "ready") throw new Error("expected ready");
    expect(m.average.viewsPerDay).toBe(3);
    expect(m.viewsGapPct).toBe(-33.3);
  });
  it("a young comparable is measured over the days it has been live, not 30", () => {
    const m = marketComparison(subject, undefined, [cand(1, { ageDays: 10, views30: 50 }), cand(2), cand(3)]);
    if (m.state !== "ready") throw new Error("expected ready");
    expect(m.rows.find(r => r.ageDays === 10)!.viewsPerDay).toBe(5);
  });
});

describe("heatmap", () => {
  it("is Monday first, 4-hour blocks, and names the busiest cell", () => {
    const h = buildHeatmap([{ dow: 0, block: 4, n: 30 }, { dow: 1, block: 2, n: 10 }, { dow: 6, block: 0, n: 2 }]); // Postgres Sunday = 0
    if (h.state !== "ready") throw new Error("expected ready");
    expect(h.total).toBe(42);
    expect(h.cells[6]![4]).toBe(30);
    expect(h.cells[0]![2]).toBe(10);
    expect(h.cells[5]![0]).toBe(2);
    expect(h.peak).toEqual({ day: "Sun", block: "4p-8p" });
  });
  it("is unavailable under 20 views", () => { expect(buildHeatmap([{ dow: 1, block: 1, n: 19 }]).state).toBe("unavailable"); });
});

describe("Elena advice", () => {
  const stats = (views: number, inquiries: number, offers = 0) => totalsFor(pts(30, () => ({ views: views / 30, inquiries: inquiries / 30, offers: offers / 30 })), "2026-11-05", 30, 40);
  const base = (over: Partial<Parameters<typeof elenaAdvice>[0]> = {}) => {
    const candidates = [1, 2, 3, 4, 5].map(i => cand(i, { priceCents: 90_000_000 + i * 2_000_000, views30: 150 - i * 20, daysToFirstOffer: 20 }));
    const s = stats(30, 1);
    return { subject, ageDays: 40, photoCount: 5, stats30: s, offersEver: 0, market: marketComparison(subject, s, candidates), candidates, ...over };
  };
  it("flags an underperforming listing and suggests a price cut and photos", () => {
    const a = elenaAdvice(base());
    expect(a.risk.level).toBe("at_risk");
    expect(a.risk.message).toMatch(/underperforming/i);
    expect(a.risk.message).toMatch(/price cut/);
    expect(a.risk.message).toMatch(/photos/);
  });
  it("recommends the median asking price with a views estimate when priced above it", () => {
    const a = elenaAdvice(base());
    if (a.recommendation.state !== "ready") throw new Error("expected ready");
    expect(a.recommendation.targetCents).toBe(96_000_000);
    expect(a.recommendation.viewsGainPct).toBeGreaterThan(0);
    expect(a.recommendation.viewsGainPct).toBeLessThanOrEqual(40);
    expect(a.recommendation.message).toMatch(/Repricing/);
  });
  it("makes no price recommendation when the asking price is at or below the middle", () => {
    expect(elenaAdvice(base({ subject: { ...subject, priceCents: 95_000_000 } })).recommendation.state).toBe("unavailable");
  });
  it("predicts days to first offer from similar listings scaled by views, and never once an offer exists", () => {
    const a = elenaAdvice(base({ ageDays: 5 }));
    if (a.prediction.state !== "ready") throw new Error("expected ready");
    expect(a.prediction.days).toBeGreaterThan(0);
    expect(a.prediction.low).toBeLessThanOrEqual(a.prediction.days);
    expect(a.prediction.high).toBeGreaterThanOrEqual(a.prediction.days);
    expect(elenaAdvice(base({ offersEver: 1 })).prediction.state).toBe("has_offer");
  });
  it("says unavailable instead of inventing a number when data is thin", () => {
    const a = elenaAdvice(base({ market: { state: "unavailable", message: "x" }, candidates: [], stats30: stats(10, 0) }));
    expect(a.prediction.state).toBe("unavailable");
    expect(a.recommendation.state).toBe("unavailable");
  });
  it("is calm when the listing keeps pace with the market", () => {
    const candidates = [1, 2, 3].map(i => cand(i, { views30: 30, inquiries30: 3 }));
    const s = stats(30, 3);
    expect(elenaAdvice({ subject, ageDays: 40, photoCount: 12, stats30: s, offersEver: 0, market: marketComparison(subject, s, candidates), candidates }).risk.level).toBe("ok");
  });
  it("elasticity needs five priced comparables and a falling slope", () => {
    expect(priceElasticity([{ priceCents: 100, viewsPerDay: 5 }])).toBeUndefined();
    const down = [1, 2, 3, 4, 5].map(i => ({ priceCents: 90_000_000 + i * 5_000_000, viewsPerDay: 10 - i }));
    expect(priceElasticity(down)).toBeLessThan(0);
    expect(priceElasticity([1, 2, 3, 4, 5].map(i => ({ priceCents: 90_000_000 + i * 5_000_000, viewsPerDay: i })))).toBeUndefined();
  });
});
