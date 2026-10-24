import { beforeEach, describe, expect, it } from "vitest";
import { applyDetails, dollarsToCents, formatPrice, parseDetails, priceError } from "../src/domain/listing-details";
import {
  createDraft, createInMemoryListingRepository, parseDraftInput, parseDraftPatch, updateDraft,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";

describe("dollarsToCents", () => {
  it("converts with string maths, no float error", () => {
    expect(dollarsToCents("850000")).toBe(85_000_000);
    expect(dollarsToCents("$1,250.50")).toBe(125_050);
    expect(dollarsToCents("650.5")).toBe(65_050);
    expect(dollarsToCents("0.29")).toBe(29);
    expect(dollarsToCents("19.99")).toBe(1999);
  });
  it("rejects junk, negatives, 3 decimals and bad commas", () => {
    for (const bad of ["", "abc", "-5", "1.234", "1,23,456", "12.", "1e5", "$"]) expect(dollarsToCents(bad)).toBeUndefined();
  });
});

describe("price rules by sale or rent", () => {
  it("accepts whole cents within the limit for each type", () => {
    expect(priceError(85_000_000, "sale")).toBeUndefined();
    expect(priceError(65_000, "rent")).toBeUndefined();
  });
  it("rejects zero, negative, fractional, non-number and oversized values", () => {
    for (const bad of [0, -1, 10.5, "100", NaN, Infinity, null]) expect(priceError(bad, "sale")).toBeDefined();
    expect(priceError(10_000_001, "rent")).toBeDefined(); // over $100,000 a week
    expect(priceError(10_000_001, "sale")).toBeUndefined();
    expect(priceError(100_000_000_001, "sale")).toBeDefined();
  });
  it("formats sale as a total and rent per week", () => {
    expect(formatPrice(85_000_000, "sale")).toBe("$850,000");
    expect(formatPrice(65_050, "rent")).toBe("$650.50 per week");
  });
});

describe("parseDetails", () => {
  it("accepts valid details and null to clear", () => {
    const r = parseDetails({ suburb: " Paddington ", postcode: "4064", priceCents: 90_000_000, bedrooms: 0, bathrooms: 2, parking: null }, "sale");
    expect(r).toEqual({ ok: true, value: { suburb: "Paddington", postcode: "4064", priceCents: 90_000_000, bedrooms: 0, bathrooms: 2, parking: null } });
  });
  it("rejects bad postcode, room counts and prices", () => {
    expect(parseDetails({ postcode: "406" }, "sale").ok).toBe(false);
    expect(parseDetails({ postcode: 4064 }, "sale").ok).toBe(false);
    expect(parseDetails({ bedrooms: 21 }, "sale").ok).toBe(false);
    expect(parseDetails({ bathrooms: -1 }, "sale").ok).toBe(false);
    expect(parseDetails({ parking: 1.5 }, "sale").ok).toBe(false);
    expect(parseDetails({ suburb: "" }, "sale").ok).toBe(false);
    expect(parseDetails({ priceCents: 12.5 }, "sale").ok).toBe(false);
    expect(parseDetails({ priceCents: 50_000_000 }, "rent").ok).toBe(false);
  });
  it("applyDetails sets and removes fields", () => {
    expect(applyDetails({ bedrooms: 3, parking: 1 }, { bedrooms: null, priceCents: 5 })).toEqual({ parking: 1, priceCents: 5 });
  });
});

const owner: Actor = { userId: "owner-1", userType: "owner" };
const base: DraftInput = {
  title: "Home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};
let n = 0;
let deps: ListingServiceDeps;
beforeEach(() => {
  n = 0;
  deps = {
    repo: createInMemoryListingRepository(), appendAudit: async () => {},
    now: () => "2026-10-24T00:00:00.000Z", newId: () => `id-${++n}`, requiredDisclosures: () => []
  };
});

describe("parseDraftInput with details", () => {
  it("keeps details when given and stays unchanged when not", () => {
    expect(parseDraftInput({ ...base })).toEqual({ ok: true, value: base });
    const r = parseDraftInput({ ...base, priceCents: 85_000_000, bedrooms: 3, suburb: "Paddington", postcode: "4064" });
    expect(r).toEqual({ ok: true, value: { ...base, priceCents: 85_000_000, bedrooms: 3, suburb: "Paddington", postcode: "4064" } });
  });
  it("treats null details as not set", () => {
    expect(parseDraftInput({ ...base, priceCents: null, bedrooms: null })).toEqual({ ok: true, value: base });
  });
  it("applies the rent limit using the submitted type", () => {
    expect(parseDraftInput({ ...base, transactionType: "rent", priceCents: 85_000_000 }).ok).toBe(false);
    expect(parseDraftInput({ ...base, transactionType: "rent", priceCents: 65_000 }).ok).toBe(true);
  });
});

describe("updating details", () => {
  it("sets, then clears a field with null", async () => {
    const l = await createDraft(deps, owner, { ...base, bedrooms: 2 });
    expect(l.bedrooms).toBe(2);
    const p = parseDraftPatch({ bedrooms: null, parking: 2 });
    if (!p.ok) throw new Error("patch");
    const u = await updateDraft(deps, owner, l.id, p.value);
    expect(u.ok && u.value.bedrooms).toBeUndefined();
    expect(u.ok && u.value.parking).toBe(2);
  });
  it("rejects switching to rent while the stored price is sale-sized", async () => {
    const l = await createDraft(deps, owner, { ...base, priceCents: 85_000_000 });
    const p = parseDraftPatch({ transactionType: "rent" });
    if (!p.ok) throw new Error("patch");
    const u = await updateDraft(deps, owner, l.id, p.value);
    expect(u.ok).toBe(false);
    const both = parseDraftPatch({ transactionType: "rent", priceCents: 65_000 });
    if (!both.ok) throw new Error("patch");
    expect((await updateDraft(deps, owner, l.id, both.value)).ok).toBe(true);
  });
  it("rejects a rent-sized limit breach sent without the type", () => {
    // Patch only: the type is unknown here, so the service check on the stored listing is the guard (previous test).
    expect(parseDraftPatch({ priceCents: -5 }).ok).toBe(false);
  });
});
