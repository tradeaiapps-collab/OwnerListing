import { describe, expect, it } from "vitest";
import { matchesSearch, toListingSummary, type SavedSearch } from "../src/domain/buyer";
import type { PropertyListing } from "../src/domain/listing";
import { parseSearchQuery } from "../src/domain/listing-search";
import { parseSavedSearchInput } from "../src/domain/saved-search-service";
import { savedInputFromQuery, savedSearchHref } from "../src/domain/saved-search-link";
import { buildAlertCandidateQuery } from "../src/server/publish-alerts-db";
import { toSearch } from "../src/server/saved-search-db";

const base = { transactionType: "sale", useClass: "residential" };
const listing = (o: Partial<PropertyListing> = {}): PropertyListing => ({
  id: "l1", ownerUserId: "o", ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Secret title", propertyType: "house", useClass: "residential",
  transactionType: "sale", address: "1 Secret St", disclosures: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  suburb: "Paddington", priceCents: 90_000_000, bedrooms: 3, bathrooms: 2, parking: 1, amenities: ["pool", "garage"], latitude: -27.459, longitude: 153.006, ...o
});
const S = (o: Partial<SavedSearch> = {}): SavedSearch => ({ id: "s", buyerUserId: "b", transactionType: "sale", useClass: "residential", jurisdictions: [], suburbs: [], propertyTypes: [], active: true, ...o });

describe("saved search input", () => {
  it("accepts the new property facts", () => {
    const r = parseSavedSearchInput({ ...base, minBathrooms: 2, minParking: 1, amenities: ["solar", "pool"], near: { latitude: -27.47, longitude: 153.02, radiusKm: 10 } });
    expect(r).toMatchObject({ ok: true, value: { minBathrooms: 2, minParking: 1, amenities: ["solar", "pool"], near: { latitude: -27.47, longitude: 153.02, radiusKm: 10 } } });
  });
  it("rejects bad amenities, bad points, odd keys and free text", () => {
    for (const bad of [{ amenities: ["moat"] }, { near: { latitude: 51, longitude: 0, radiusKm: 5 } }, { near: { latitude: -27, longitude: 153, radiusKm: 500 } },
      { near: { latitude: -27, longitude: 153 } }, { near: { latitude: -27, longitude: 153, radiusKm: 5, extra: 1 } }, { minBathrooms: -1 }, { q: "pool" }, { title: "x" }]) {
      expect(parseSavedSearchInput({ ...base, ...bad }).ok).toBe(false);
    }
  });
  it("survives storage: a stored row reads back the same, a corrupt row is skipped", () => {
    const input = { ...base, jurisdictions: [], suburbs: [], propertyTypes: [], amenities: ["pool"], minParking: 2 };
    const parsed = parseSavedSearchInput(input);
    expect(parsed.ok && toSearch({ id: "s", buyer_user_id: "b", active: true, criteria: input })).toMatchObject({ amenities: ["pool"], minParking: 2 });
    expect(toSearch({ id: "s", buyer_user_id: "b", active: true, criteria: { ...input, amenities: ["moat"] } })).toBeUndefined();
  });
});

describe("matching a new listing", () => {
  const l = toListingSummary(listing());
  it("carries the new facts but never title, address or owner", () => {
    expect(l).toMatchObject({ bathrooms: 2, parking: 1, amenities: ["pool", "garage"], latitude: -27.459 });
    expect(JSON.stringify(l)).not.toMatch(/Secret|owner/i);
  });
  it("checks bathrooms, parking, amenities and distance", () => {
    expect(matchesSearch(S({ minBathrooms: 2, minParking: 1, amenities: ["pool"] }), l)).toBe(true);
    expect(matchesSearch(S({ minBathrooms: 3 }), l)).toBe(false);
    expect(matchesSearch(S({ minParking: 2 }), l)).toBe(false);
    expect(matchesSearch(S({ amenities: ["pool", "solar"] }), l)).toBe(false);
    expect(matchesSearch(S({ near: { latitude: -27.47, longitude: 153.02, radiusKm: 10 } }), l)).toBe(true);
    expect(matchesSearch(S({ near: { latitude: -28.0, longitude: 153.43, radiusKm: 10 } }), l)).toBe(false);
  });
  it("a listing missing a fact fails a search that needs it", () => {
    const { bathrooms: _b, parking: _p, amenities: _a, latitude: _la, longitude: _lo, ...rest } = listing();
    const bare = toListingSummary(rest);
    for (const s of [S({ minBathrooms: 1 }), S({ minParking: 1 }), S({ amenities: ["pool"] }), S({ near: { latitude: -27.47, longitude: 153.02, radiusKm: 99 } })]) {
      expect(matchesSearch(s, bare)).toBe(false);
    }
    expect(matchesSearch(S(), bare)).toBe(true);
  });
  it("the database shortlist only ever leaves out searches, so the new criteria need no SQL there", () => {
    expect(buildAlertCandidateQuery(l).text).not.toMatch(/amenit|near|minBath/);
  });
});

describe("links between filters and saved searches", () => {
  it("opens a saved search on the listings page with the same filters", () => {
    const href = savedSearchHref(S({ jurisdictions: ["QLD"], propertyTypes: ["house"], suburbs: ["Paddington"], maxPriceCents: 9, minBedrooms: 3, amenities: ["pool", "solar"], near: { latitude: -27.4, longitude: 153, radiusKm: 5 } }));
    const q = parseSearchQuery(new URL(href, "https://x.test").searchParams);
    expect(q).toMatchObject({ transactionType: "sale", useClass: "residential", jurisdiction: "QLD", propertyType: "house", suburb: "Paddington", maxPriceCents: 9, minBedrooms: 3, amenities: ["pool", "solar"], near: { radiusKm: 5 } });
  });
  it("opens wider, not narrower, when a saved search lists several states", () => {
    expect(savedSearchHref(S({ jurisdictions: ["QLD", "NSW"] }))).not.toContain("jurisdiction");
  });
  it("turns the listing filters into a saved search", () => {
    const q = parseSearchQuery(new URLSearchParams({ transactionType: "rent", propertyType: "office", suburb: "Fortitude Valley", amenities: "lift", minBedrooms: "0", q: "river", postcode: "4006" }));
    const r = savedInputFromQuery(q);
    expect(r).toMatchObject({ ok: true, dropped: ["search words", "postcode"], value: { transactionType: "rent", useClass: "commercial", suburbs: ["Fortitude Valley"], propertyTypes: ["office"], amenities: ["lift"], minBedrooms: 0 } });
    expect(r.ok && parseSavedSearchInput(r.value).ok).toBe(true);
  });
  it("needs sale or rent first", () => {
    expect(savedInputFromQuery(parseSearchQuery(new URLSearchParams()))).toEqual({ ok: false, message: "Choose sale or rent to save this search." });
  });
});
