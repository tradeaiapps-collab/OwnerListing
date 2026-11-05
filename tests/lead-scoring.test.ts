import { describe, expect, it } from "vitest";
import { scoreLead, type LeadFact } from "../src/domain/agent-workspace";
import { DEFAULT_SCORING, blend, bandFor, fitPercent, followUpUrgency, parseFitSearches, parseOverride, parseScoringConfig, type ScoringConfig } from "../src/domain/lead-scoring";

const NOW = new Date("2026-11-05T00:00:00Z");
const base = (o: Partial<LeadFact> = {}): LeadFact => ({
  enquiryId: "e1", listingId: "l1", listingTitle: "Home", buyerId: "b1", buyerName: "Sam", enquiredAt: "2026-11-04T00:00:00Z", buyerMessages: 2, agentMessages: 1, notes: 0, ...o
});

describe("scoring settings", () => {
  const ok = { hotMin: 75, warmMin: 45, weights: { engagement: 50, fit: 30, followUp: 20 } };
  it("accepts whole thresholds and weights that add to 100", () => {
    expect(parseScoringConfig(ok)).toEqual({ ok: true, value: ok });
  });
  it.each([
    [{ ...ok, warmMin: 80 }, "lower than the hot"],
    [{ ...ok, hotMin: 70.5 }, "whole numbers"],
    [{ ...ok, hotMin: 101 }, "whole numbers"],
    [{ ...ok, weights: { engagement: 50, fit: 30, followUp: 30 } }, "add up to 100"],
    [{ ...ok, weights: { engagement: -10, fit: 60, followUp: 50 } }, "0 to 100"],
    [{ ...ok, weights: { engagement: "60", fit: 25, followUp: 15 } }, "0 to 100"],
    [null, "whole numbers"]
  ])("rejects %j", (input, msg) => {
    const r = parseScoringConfig(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(msg);
  });
  it("bands follow the thresholds", () => {
    expect([69, 70, 39, 40].map(n => bandFor(n, DEFAULT_SCORING))).toEqual(["warm", "hot", "cold", "warm"]);
  });
});

describe("property fit", () => {
  const listing = { priceCents: 90_000_000, bedrooms: 3, suburb: "Paddington", propertyType: "house", transactionType: "sale" };
  it("is undefined without a saved search", () => {
    expect(fitPercent({ ...listing, searches: [] })).toBeUndefined();
    expect(fitPercent(undefined)).toBeUndefined();
    expect(fitPercent({ ...listing, searches: [{}] })).toBeUndefined();
  });
  it("counts only the criteria the buyer set, and the best search wins", () => {
    const f = fitPercent({ ...listing, searches: [
      { suburbs: ["Red Hill"], minBedrooms: 4, maxPriceCents: 80_000_000, propertyTypes: ["house"] },
      { suburbs: ["paddington"], minBedrooms: 3, maxPriceCents: 95_000_000 }
    ] });
    expect(f?.percent).toBe(100);
    expect(f?.reasons).toContain("Matches saved-search suburb");
    expect(fitPercent({ ...listing, searches: [{ suburbs: ["Red Hill"], minBedrooms: 4, maxPriceCents: 80_000_000, propertyTypes: ["house"] }] })?.percent).toBe(25);
  });
  it("skips a check the listing has no data for", () => {
    expect(fitPercent({ suburb: "Paddington", searches: [{ suburbs: ["Paddington"], minBedrooms: 3 }] })?.percent).toBe(100);
  });
  it("drops malformed stored criteria", () => {
    expect(parseFitSearches("x")).toEqual([]);
    expect(parseFitSearches([null, 5, { minBedrooms: -1, suburbs: ["A", 3], maxPriceCents: 10 }])).toEqual([{ suburbs: ["A"], maxPriceCents: 10 }]);
  });
});

describe("follow-up timing", () => {
  it("ranks overdue above due soon above later above none", () => {
    const v = (d?: string, idle = 1) => followUpUrgency("contacted", d, idle, "2026-11-05").value;
    expect([v("2026-11-01"), v("2026-11-06"), v("2026-12-01"), v(undefined, 1)]).toEqual([100, 75, 35, 25]);
    expect(v(undefined, 20)).toBe(60);
  });
  it("is zero for closed leads", () => {
    expect(followUpUrgency("won", "2026-11-01", 1, "2026-11-05").value).toBe(0);
    expect(followUpUrgency("lost", undefined, 30, "2026-11-05").value).toBe(0);
  });
});

describe("blend", () => {
  it("scales the remaining weights when fit is missing", () => {
    expect(blend({ engagement: 80, followUp: 20 }, DEFAULT_SCORING)).toBe(Math.round((80 * 60 + 20 * 15) / 75));
    expect(blend({ engagement: 80, fit: 100, followUp: 20 }, DEFAULT_SCORING)).toBe(Math.round((80 * 60 + 100 * 25 + 20 * 15) / 100));
  });
  it("handles zero total weight and clamps", () => {
    const zero: ScoringConfig = { hotMin: 70, warmMin: 40, weights: { engagement: 0, fit: 0, followUp: 0 } };
    expect(blend({ engagement: 55, followUp: 90 }, zero)).toBe(55);
    expect(blend({ engagement: 100, fit: 100, followUp: 100 }, DEFAULT_SCORING)).toBe(100);
  });
});

describe("scoreLead", () => {
  it("without rules is the original engagement score", () => {
    const l = scoreLead(base({ followUpAt: "2026-11-01", fit: { searches: [{ suburbs: ["X"] }], suburb: "X" } }), NOW);
    expect(l.score).toBe(scoreLead(base(), NOW).score);
    expect(l.autoScore).toBeUndefined();
  });
  it("a matching buyer with an overdue follow-up outranks an identical buyer with no fit", () => {
    const fit = { suburb: "Paddington", bedrooms: 3, searches: [{ suburbs: ["Paddington"], minBedrooms: 3 }] };
    const a = scoreLead(base({ fit, followUpAt: "2026-11-01" }), NOW, DEFAULT_SCORING);
    const b = scoreLead(base({ fit: { suburb: "Paddington", bedrooms: 3, searches: [{ suburbs: ["Elsewhere"], minBedrooms: 6 }] } }), NOW, DEFAULT_SCORING);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.fitPercent).toBe(100);
    expect(a.reasons).toEqual(expect.arrayContaining(["100% match to saved searches", "Follow-up is overdue"]));
  });
  it("agent override replaces the score, keeps the automatic one and re-bands", () => {
    const auto = scoreLead(base(), NOW, DEFAULT_SCORING);
    const o = scoreLead(base({ override: { score: 95, reason: "Pre-approved", at: "2026-11-04T00:00:00Z" } }), NOW, DEFAULT_SCORING);
    expect(o).toMatchObject({ score: 95, band: "hot", autoScore: auto.score, overridden: true });
    expect(o.reasons).toContain("Agent override: Pre-approved");
    expect(scoreLead(base({ override: { score: 5, reason: "Not serious", at: "x" } }), NOW, DEFAULT_SCORING).band).toBe("cold");
  });
  it("uses the staff thresholds for the band", () => {
    const cfg: ScoringConfig = { ...DEFAULT_SCORING, hotMin: 20, warmMin: 10 };
    expect(scoreLead(base(), NOW, cfg).band).toBe("hot");
  });
});

describe("override input", () => {
  it("needs a whole score 0-100 and a reason", () => {
    expect(parseOverride({ score: 80, reason: " Ready to offer " })).toEqual({ ok: true, value: { score: 80, reason: "Ready to offer" } });
    for (const bad of [{ score: 101, reason: "abc" }, { score: 50.5, reason: "abc" }, { score: "50", reason: "abc" }, { score: 50, reason: "  " }, { score: 50, reason: "x".repeat(301) }, null]) {
      expect(parseOverride(bad).ok).toBe(false);
    }
  });
});
