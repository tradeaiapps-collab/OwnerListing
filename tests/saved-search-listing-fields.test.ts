import { describe, expect, it } from "vitest";
import { createUnconfiguredAlertDelivery } from "../src/adapters/alert-delivery";
import { dispatchAlerts, planNewAlerts, type DeliveryLogEntry } from "../src/domain/alerts";
import { matchesSearch, toListingSummary, type SavedSearch } from "../src/domain/buyer";
import type { PropertyListing } from "../src/domain/listing";
import { actionHref, actionPath } from "../src/domain/listing-actions";
import { safeNext } from "../src/server/auth/safe-next";
import { savedSearchFormBody } from "../app/buyer/saved-searches/form";

const ID = "11111111-2222-3333-4444-555555555555";
const prop = (o: Partial<PropertyListing> = {}): PropertyListing => ({
  id: ID, ownerUserId: "owner-secret", ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Private title",
  propertyType: "house", useClass: "residential", transactionType: "sale", address: "1 Secret St", disclosures: [],
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  suburb: "New Farm", postcode: "4005", priceCents: 120000000, bedrooms: 4, bathrooms: 2, parking: 1, ...o
});
const search = (o: Partial<SavedSearch> = {}): SavedSearch => ({
  id: "s1", buyerUserId: "b1", transactionType: "sale", useClass: "residential", jurisdictions: [], suburbs: [], propertyTypes: [], active: true, ...o
});

describe("PropertyListing to ListingSummary", () => {
  it("carries only the fields searches use", () => {
    const s = toListingSummary(prop());
    expect(s).toEqual({ id: ID, status: "published", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house", suburb: "New Farm", priceCents: 120000000, bedrooms: 4, bathrooms: 2, parking: 1 });
    expect(JSON.stringify(s)).not.toMatch(/owner-secret|Secret St|Private title/);
  });
  it("matches on suburb, price, bedrooms and property type", () => {
    const l = toListingSummary(prop());
    expect(matchesSearch(search({ suburbs: ["new farm"], maxPriceCents: 150000000, minPriceCents: 100000000, minBedrooms: 3, propertyTypes: ["house"] }), l)).toBe(true);
    expect(matchesSearch(search({ suburbs: ["Paddington"] }), l)).toBe(false);
    expect(matchesSearch(search({ maxPriceCents: 100000000 }), l)).toBe(false);
    expect(matchesSearch(search({ minPriceCents: 130000000 }), l)).toBe(false);
    expect(matchesSearch(search({ minBedrooms: 5 }), l)).toBe(false);
    expect(matchesSearch(search({ propertyTypes: ["unit"] }), l)).toBe(false);
  });
  it("denies a listing missing a field the search filters on", () => {
    const { suburb: _s, priceCents: _p, bedrooms: _b, ...rest } = prop();
    const bare = toListingSummary(rest);
    expect(matchesSearch(search(), bare)).toBe(true);
    expect(matchesSearch(search({ suburbs: ["New Farm"] }), bare)).toBe(false);
    expect(matchesSearch(search({ minPriceCents: 1 }), bare)).toBe(false);
    expect(matchesSearch(search({ maxPriceCents: 999999999 }), bare)).toBe(false);
    expect(matchesSearch(search({ minBedrooms: 0 }), bare)).toBe(false);
  });
  it("denies unpublished and withdrawn listings and inactive searches", () => {
    for (const status of ["draft", "pending_review", "withdrawn"] as const) expect(matchesSearch(search(), toListingSummary(prop({ status })))).toBe(false);
    expect(matchesSearch(search({ active: false }), toListingSummary(prop()))).toBe(false);
  });
  it("sends nothing while no delivery provider is configured, and plans only for consenting buyers", async () => {
    const l = toListingSummary(prop());
    const prefs = { b1: [{ channel: "email" as const, consentGivenAt: "2026-01-01T00:00:00Z" }], b2: [{ channel: "email" as const }] };
    const plans = planNewAlerts(l, [search({ suburbs: ["New Farm"] }), search({ id: "s2", buyerUserId: "b2" })], prefs, new Set());
    expect(plans.map(p => p.buyerUserId)).toEqual(["b1"]);
    const log: DeliveryLogEntry[] = [];
    await dispatchAlerts(plans, { port: createUnconfiguredAlertDelivery(), prefsByBuyer: prefs, alreadySent: new Set(), unsubscribeUrlFor: () => "https://x.test/u", now: () => "t", log: async e => { log.push(e); } });
    expect(log.map(e => e.outcome)).toEqual(["not_configured"]);
  });
});

describe("saved-search form", () => {
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ transactionType: "sale", useClass: "residential", ...o })) f.set(k, v);
    return f;
  };
  it("builds the API body from suburb, price and bedrooms", () => {
    const r = savedSearchFormBody(fd({ suburbs: "New Farm, Teneriffe", minPrice: "$500,000", maxPrice: "850000", minBedrooms: "3", propertyType: "house" }));
    expect(r).toEqual({ body: expect.objectContaining({ suburbs: ["New Farm", "Teneriffe"], minPriceCents: 50000000, maxPriceCents: 85000000, minBedrooms: 3, propertyTypes: ["house"] }) });
  });
  it.each([
    [{ minPrice: "abc" }], [{ maxPrice: "1e5" }], [{ minPrice: "-5" }], [{ minPrice: "10.123" }],
    [{ minPrice: "900000", maxPrice: "800000" }], [{ minBedrooms: "2.5" }], [{ minBedrooms: "-1" }], [{ minBedrooms: "21" }],
    [{ suburbs: "a,b,c,d,e,f,g,h,i,j,k" }], [{ suburbs: "x".repeat(81) }], [{ propertyType: "castle" }], [{ jurisdiction: "XX" }]
  ])("rejects %j", o => { expect("error" in savedSearchFormBody(fd(o))).toBe(true); });
});

describe("listing actions", () => {
  it("sends signed-out visitors to sign-in with a safe next", () => {
    for (const a of ["enquire", "save"] as const) {
      const href = actionHref(ID, a, false);
      expect(href.startsWith("/api/auth/google/start?as=buyer&next=/")).toBe(true);
      const next = new URL(href, "https://x.test").searchParams.get("next");
      expect(safeNext(next)).toBe(next);
      expect(next).toBe(actionPath(ID, a));
    }
  });
  it("sends signed-in visitors straight to the action", () => {
    expect(actionHref(ID, "enquire", true)).toBe(`/listings/${ID}/enquire`);
    expect(actionHref(ID, "save", true)).toBe(`/listings/${ID}`);
  });
  it("refuses a malformed listing id instead of building a next param", () => {
    for (const bad of ["//evil.test", "../x", "a b", "https://evil.test", ""]) {
      expect(actionPath(bad, "enquire")).toBeNull();
      expect(actionHref(bad, "enquire", false)).toBe("/listings");
    }
  });
});
