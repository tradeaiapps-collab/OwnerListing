import { describe, expect, it } from "vitest";
import {
  adminCsv, buildAdminAnalytics, buildOwnerRows, compareByTimeToSale, computeMetrics, filterAgents, monthComparison, monthRanges, parseCompareIds, parseOwnerFilter,
  parsePerformanceDays, parseRating, suggestions, type PerfAgent, type PerfFacts, type PerfOffer
} from "../src/domain/agent-performance";

const agent = (id: string, o: Partial<PerfAgent> = {}): PerfAgent => ({ agentId: id, name: id.toUpperCase(), specialties: [], areas: [], acceptingNew: true, activeListings: 0, ...o });
const offer = (agentId: string, date: string, o: Partial<PerfOffer> = {}): PerfOffer => ({ agentId, date, fellThrough: false, priceCents: 100, ...o });
const range = { from: "2026-10-01", to: "2026-10-30" }; // 30 days

describe("computeMetrics", () => {
  it("averages time to sale, price variance and velocity over standing sales only", () => {
    const f = { offers: [offer("a", "2026-10-05", { daysToSale: 20, priceCents: 105, listCents: 100 }), offer("a", "2026-10-10", { daysToSale: 40, priceCents: 95, listCents: 100 }), offer("a", "2026-09-01", { daysToSale: 1 })], ratings: [] };
    const m = computeMetrics(f, range, "a");
    expect(m).toMatchObject({ sold: 2, timeToSaleDays: 30, priceVariancePercent: 0, dealVelocity: 2, acceptedOffers: 2, fellThrough: 0 });
    expect(m.fallThroughRate).toBeUndefined(); // under 3 accepted offers: not judged
  });
  it("counts fallen-through offers in the rate but not in sales or time to sale", () => {
    const f = { offers: [offer("a", "2026-10-02", { daysToSale: 10 }), offer("a", "2026-10-03", { fellThrough: true, daysToSale: 90 }), offer("a", "2026-10-04", { fellThrough: true }), offer("a", "2026-10-05", { daysToSale: 20 })], ratings: [] };
    expect(computeMetrics(f, range, "a")).toMatchObject({ sold: 2, fellThrough: 2, acceptedOffers: 4, timeToSaleDays: 15, fallThroughRate: 50 });
  });
  it("averages buyer ratings and leaves measures missing when there is nothing to measure", () => {
    const f = { offers: [], ratings: [{ agentId: "a", date: "2026-10-05", rating: 5, comment: "" }, { agentId: "a", date: "2026-10-06", rating: 4, comment: "ok" }, { agentId: "b", date: "2026-10-06", rating: 1, comment: "" }] };
    expect(computeMetrics(f, range, "a")).toMatchObject({ satisfaction: 4.5, ratingCount: 2, sold: 0 });
    expect(computeMetrics(f, range, "c").satisfaction).toBeUndefined();
  });
});

describe("ranking and owner list", () => {
  const facts: PerfFacts = {
    agents: [agent("slow", { areas: ["Ascot"], specialties: ["investors"] }), agent("fast", { areas: ["Paddington"], acceptingNew: false }), agent("none", { areas: ["Ascot"] })],
    offers: [offer("slow", "2026-10-02", { daysToSale: 60 }), offer("fast", "2026-10-02", { daysToSale: 15 })], ratings: []
  };
  it("ranks fastest first and agents without a sale last", () => {
    const rows = buildOwnerRows(facts, range, new Set());
    expect(rows.map(r => r.agentId)).toEqual(["fast", "slow", "none"]);
  });
  it("puts favourites first and filters by location, specialty and availability", () => {
    const rows = buildOwnerRows(facts, range, new Set(["slow"]));
    expect(rows[0]!.agentId).toBe("slow");
    const f = (qs: string) => filterAgents(rows, parseOwnerFilter(new URLSearchParams(qs))).map(r => r.agentId);
    expect(f("area=asc").sort()).toEqual(["none", "slow"]);
    expect(f("specialty=investors")).toEqual(["slow"]);
    expect(f("available=1").sort()).toEqual(["none", "slow"]);
  });
  it("breaks ties on time to sale by rating then name", () => {
    const m = (t: number, s?: number) => ({ name: "x", metrics: { ...computeMetrics({ offers: [], ratings: [] }, range), timeToSaleDays: t, ...(s ? { satisfaction: s } : {}) } });
    expect(compareByTimeToSale(m(10, 5), m(10, 3))).toBeLessThan(0);
  });
});

describe("admin analytics", () => {
  it("flags agents whose fall-through rate is 25% or more with at least 3 accepted offers", () => {
    const facts: PerfFacts = {
      agents: [agent("risky"), agent("steady"), agent("thin")],
      offers: [offer("risky", "2026-10-02"), offer("risky", "2026-10-03", { fellThrough: true }), offer("risky", "2026-10-04"), offer("steady", "2026-10-02"), offer("steady", "2026-10-03"), offer("steady", "2026-10-04"),
        offer("thin", "2026-10-02", { fellThrough: true })], ratings: []
    };
    const a = buildAdminAnalytics(facts, 30, "2026-10-30", (n, i) => `Agent ${i + 1}`);
    const by = Object.fromEntries(a.rows.map(r => [r.label, r]));
    expect(a.rows.filter(r => r.flagged).length).toBe(1);
    expect(a.rows.find(r => r.flagged)!.flagReason).toContain("1 of 3");
    expect(by).toBeTruthy();
    expect(adminCsv(a).rows).toHaveLength(3);
  });
});

describe("monthly comparison and suggestions", () => {
  it("compares this month so far with the whole of last month", () => {
    expect(monthRanges("2026-11-05")).toEqual({ thisRange: { from: "2026-11-01", to: "2026-11-05" }, lastRange: { from: "2026-10-01", to: "2026-10-31" } });
    expect(monthRanges("2026-01-10").lastRange).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    const c = monthComparison({ offers: [offer("a", "2026-10-20"), offer("a", "2026-11-02")], ratings: [] }, "a", "2026-11-05");
    expect([c.lastMonth.sold, c.thisMonth.sold]).toEqual([1, 1]);
  });
  it("suggests a fix for a high fall-through rate and otherwise says nothing stands out", () => {
    const base = computeMetrics({ offers: [], ratings: [] }, range);
    expect(suggestions({ ...base, fallThroughRate: 40, fellThrough: 2, acceptedOffers: 5 }, base)[0]).toContain("fell through");
    expect(suggestions(base, base)[0]).toContain("Nothing stands out");
    expect(suggestions({ ...base, sold: 2 }, base).join(" ")).toContain("rated you");
  });
});

describe("input parsing", () => {
  it("validates ratings", () => {
    expect(parseRating({ listingId: "x", rating: 5, comment: " great " })).toEqual({ ok: true, value: { listingId: "x", rating: 5, comment: "great" } });
    for (const bad of [null, { listingId: "x", rating: 0 }, { listingId: "x", rating: 4.5 }, { rating: 4 }, { listingId: "x", rating: 4, comment: "a".repeat(1001) }]) expect(parseRating(bad).ok).toBe(false);
  });
  it("limits compare to 3 distinct valid ids and accepts only known periods", () => {
    const ok = (s: string) => /^[a-z]$/.test(s);
    expect(parseCompareIds("a,b,a", ok)).toEqual(["a", "b"]);
    expect(parseCompareIds("a,b,c,d", ok)).toBeUndefined();
    expect(parseCompareIds("a,!", ok)).toBeUndefined();
    expect(parseCompareIds(null, ok)).toEqual([]);
    expect([parsePerformanceDays(null), parsePerformanceDays("90"), parsePerformanceDays("7")]).toEqual([180, 90, undefined]);
  });
});
