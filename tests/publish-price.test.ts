import { describe, expect, it } from "vitest";
import type { PropertyListing } from "../src/domain/listing";
import { decidePublish } from "../src/domain/publish";

const sale: PropertyListing = {
  id: "l1", ownerUserId: "o1", ownerUserType: "owner", jurisdiction: "QLD", status: "draft", title: "Home",
  propertyType: "house", useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
  priceCents: 85_000_000, createdAt: "2026-10-01", updatedAt: "2026-10-01"
};
const rent: PropertyListing = { ...sale, transactionType: "rent", priceCents: 65_000 };
const ready = { termsAccepted: true, listingFeePaid: true, trustAccount: { kind: "approved" as const, reasons: [] }, rentalBondPathway: "state_bond_authority" as const };
const decide = (l: PropertyListing) => decidePublish(l, [], [], "2026-10-23", ready);
const priceReasons = (r: string[]) => r.filter(x => /asking price|weekly rent/i.test(x));
const without = (l: PropertyListing): PropertyListing => { const { priceCents: _p, ...rest } = l; return rest; };

describe("publish gate: a price is required", () => {
  it("allows a sale with an asking price and a rental with weekly rent", () => {
    expect(decide(sale)).toEqual({ allowed: true, reasons: [] });
    expect(decide(rent)).toEqual({ allowed: true, reasons: [] });
  });
  it("blocks a sale without a price, with a clear message", () => {
    const d = decide(without(sale));
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("An asking price is required to publish.");
  });
  it("blocks a rental without a rent, with a clear message", () => {
    const d = decide(without(rent));
    expect(d.allowed).toBe(false);
    expect(d.reasons).toContain("Weekly rent is required to publish.");
  });
  it("treats a null price like a missing one", () => {
    const d = decide({ ...sale, priceCents: null } as unknown as PropertyListing);
    expect(d.allowed).toBe(false);
    expect(priceReasons(d.reasons)).toHaveLength(1);
  });
  it("fails closed on zero, negative, fractional, non-numeric and over-limit prices", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "850000", 100_000_000_001]) {
      const d = decide({ ...sale, priceCents: bad as unknown as number });
      expect(d.allowed).toBe(false);
      expect(priceReasons(d.reasons)).toHaveLength(1);
    }
    // A sale-sized figure is not a valid weekly rent ($100,000 a week is the ceiling).
    expect(decide({ ...rent, priceCents: 85_000_000 }).allowed).toBe(false);
  });
  it("reports the price alongside the other failures, not instead of them", () => {
    const d = decidePublish(without(sale), [], [], "2026-10-23", {});
    expect(d.allowed).toBe(false);
    expect(priceReasons(d.reasons)).toHaveLength(1);
    expect(d.reasons.some(r => /terms/i.test(r))).toBe(true);
    expect(d.reasons.some(r => /fee/i.test(r))).toBe(true);
  });
});
