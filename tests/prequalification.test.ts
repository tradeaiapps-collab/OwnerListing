import { describe, expect, it } from "vitest";
import { assess, effectiveStatus, extractPreapproval, isUnqualified, parseBuyerDetails, parseReview, sellerView } from "../src/domain/prequalification";

const NOW = "2026-11-05T00:00:00.000Z";
const LETTER = `Commonwealth Bank of Australia. Date of issue: 1 November 2026
Dear Buyer, we are pleased to advise that you are pre-approved for a home loan of up to $450,000.
Interest rate 6.19% p.a. Loan term: 30 years. This approval is valid until 1 February 2027.
Your approval is subject to a satisfactory property valuation and building insurance.`;

describe("Elena reads a pre-approval letter", () => {
  it("finds lender, amount, rate, term, expiry and standard conditions", () => {
    const x = extractPreapproval(LETTER);
    expect(x).toMatchObject({ lender: "Commonwealth Bank", approvedCents: 45_000_000, ratePercent: 6.19, termYears: 30, issuedOn: "2026-11-01", expiresOn: "2027-02-01" });
    expect(x.conditions.sort()).toEqual(["insurance", "valuation"]);
  });
  it("works out expiry from 'valid for 90 days' and reads $480k", () => {
    const x = extractPreapproval("Westpac. Issued on 05/11/2026. Pre-approved up to $480k. Valid for 90 days. Subject to the sale of your existing property.");
    expect(x.approvedCents).toBe(48_000_000);
    expect(x.expiresOn).toBe("2027-02-03");
    expect(x.conditions).toEqual(["sale_of_property"]);
  });
  it("leaves what it cannot find empty and ignores absurd figures", () => {
    const x = extractPreapproval("Hello. Pre-approved for $5. See you.");
    expect(x.approvedCents).toBeUndefined();
    expect(x.conditions).toEqual([]);
  });
});

describe("confidence rules", () => {
  const base = { conditions: [], expiresAt: "2027-03-01T00:00:00Z", now: NOW };
  it("high: amount covers price, no conditions, over three months left", () => {
    const a = assess({ ...base, approvedCents: 50_000_000, priceCents: 45_000_000 });
    expect(a.confidence).toBe("high");
    expect(a.summary).toContain("Pre-approved for $500,000 with no conditions");
  });
  it("high with only routine conditions; medium with an other condition", () => {
    expect(assess({ ...base, approvedCents: 50_000_000, priceCents: 45_000_000, conditions: ["valuation"] }).confidence).toBe("high");
    expect(assess({ ...base, approvedCents: 50_000_000, priceCents: 45_000_000, conditions: ["credit_check"] }).confidence).toBe("medium");
  });
  it("medium at 90 to 99% of price; low below 90% with a flag", () => {
    expect(assess({ ...base, approvedCents: 41_000_000, priceCents: 45_000_000 }).confidence).toBe("medium");
    const low = assess({ ...base, approvedCents: 40_000_000, priceCents: 45_000_000 });
    expect(low.confidence).toBe("low");
    expect(low.flags.map(f => f.code)).toContain("low_vs_price");
  });
  it("low with an onerous condition or four conditions; medium for 1-3 months, low under one month or expired", () => {
    expect(assess({ ...base, approvedCents: 50_000_000, conditions: ["sale_of_property"] }).flags[0]!.code).toBe("onerous_conditions");
    expect(assess({ ...base, approvedCents: 50_000_000, conditions: ["valuation", "insurance", "lmi", "credit_check"] }).confidence).toBe("low");
    expect(assess({ ...base, approvedCents: 50_000_000, expiresAt: "2026-12-20T00:00:00Z" }).confidence).toBe("medium");
    expect(assess({ ...base, approvedCents: 50_000_000, expiresAt: "2026-11-20T00:00:00Z" }).flags[0]!.code).toBe("short_expiry");
    expect(assess({ ...base, approvedCents: 50_000_000, expiresAt: "2026-10-01T00:00:00Z" }).confidence).toBe("low");
  });
  it("no amount is low; no expiry is flagged; no price skips the amount check", () => {
    expect(assess({ ...base, approvedCents: undefined }).flags[0]!.code).toBe("no_amount");
    expect(assess({ conditions: [], approvedCents: 50_000_000, now: NOW }).flags.map(f => f.code)).toEqual(["no_expiry"]);
    expect(assess({ ...base, approvedCents: 5_000_000 }).confidence).toBe("high");
  });
});

describe("seller view hides anything unverified", () => {
  const row = { status: "verified" as const, approvedCents: 50_000_000, conditions: ["valuation" as const], expiresAt: "2027-03-01T00:00:00Z" };
  it("verified shows the summary, amount and conditions", () => {
    const v = sellerView(row, 45_000_000, NOW);
    expect(v).toMatchObject({ state: "verified", confidence: "high", approvedCents: 50_000_000, conditions: ["a satisfactory property valuation"] });
    expect(v.label).toContain("✓");
  });
  it("pending shows status only; past expiry reads expired; no row reads none", () => {
    const p = sellerView({ ...row, status: "pending_review" }, 45_000_000, NOW);
    expect(p).toEqual({ state: "pending", label: "⚠ Pending review" });
    expect(sellerView({ ...row, expiresAt: "2026-10-01T00:00:00Z" }, 45_000_000, NOW).state).toBe("expired");
    expect(sellerView(undefined, 45_000_000, NOW).state).toBe("none");
    expect(effectiveStatus("verified", "2026-10-01T00:00:00Z", NOW)).toBe("expired");
  });
  it("unqualified: none, expired, or under 90% of price", () => {
    expect(isUnqualified("none", undefined, 1)).toBe(true);
    expect(isUnqualified("verified", 80, 100)).toBe(true);
    expect(isUnqualified("verified", 95, 100)).toBe(false);
  });
});

describe("input parsing", () => {
  it("buyer details are optional and validated", () => {
    expect(parseBuyerDetails({})).toEqual({ ok: true, value: { conditions: [], shareWithSellers: true } });
    expect(parseBuyerDetails({ amount: "$450,000", rate: "6.2%", term: "30", conditions: "valuation,insurance", share: "false" })).toMatchObject({ ok: true, value: { approvedCents: 45_000_000, ratePercent: 6.2, termYears: 30, shareWithSellers: false } });
    for (const f of [{ amount: "12" }, { amount: "abc" }, { rate: "90" }, { term: "99" }, { conditions: "bogus" }, { listingId: "nope" }]) expect(parseBuyerDetails(f).ok).toBe(false);
  });
  it("staff verify needs amount and a future expiry; resubmit needs a note", () => {
    const ok = parseReview({ action: "verify", approvedCents: 45_000_000, expiresOn: "2027-02-01", conditions: ["valuation"] }, "2026-11-05");
    expect(ok).toMatchObject({ ok: true, value: { approvedCents: 45_000_000, expiresOn: "2027-02-01" } });
    for (const b of [{ action: "verify", approvedCents: 1, expiresOn: "2027-02-01" }, { action: "verify", approvedCents: 45_000_000, expiresOn: "2026-01-01" },
      { action: "verify", approvedCents: 45_000_000, expiresOn: "2031-01-01" }, { action: "verify", approvedCents: 45_000_000, expiresOn: "2027-02-30" },
      { action: "resubmit" }, { action: "approve" }]) expect(parseReview(b, "2026-11-05").ok).toBe(false);
    expect(parseReview({ action: "resubmit", note: "Please send page 2." }, "2026-11-05").ok).toBe(true);
  });
});
