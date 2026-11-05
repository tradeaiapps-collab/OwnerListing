import { describe, expect, it } from "vitest";
import { AMENITIES, parseDetails } from "../src/domain/listing-details";
import { bboxAround, distanceKm, parseNear, parseSearchQuery, searchInMemory, searchWords, type SearchQuery } from "../src/domain/listing-search";
import type { PropertyListing } from "../src/domain/listing";
import { buildSearch } from "../src/server/listing-search-sql";
import { readFileSync } from "node:fs";

let n = 0;
const L = (over: Partial<PropertyListing>): PropertyListing => {
  n += 1;
  return {
    id: `a-${String(n).padStart(2, "0")}`, ownerUserId: "o", ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: `T${n}`,
    propertyType: "house", useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
    createdAt: `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`, updatedAt: "2026-10-24T00:00:00.000Z", ...over
  };
};
const p = (o: Record<string, string>) => parseSearchQuery(new URLSearchParams(o));
const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ sort: "newest", page: 1, pageSize: 12, ...over });

// Brisbane CBD, Paddington (about 3 km away), Gold Coast (about 70 km away).
const data = [
  L({ title: "Pool house", suburb: "Paddington", address: "5 Latrobe Tce Paddington", description: "Renovated family home with a saltwater pool", amenities: ["pool", "garage"], latitude: -27.459, longitude: 153.006, priceCents: 90_000_000 }),
  L({ title: "City unit", propertyType: "unit", suburb: "Brisbane City", address: "10 Queen St", description: "Walk to everything", amenities: ["lift", "security"], latitude: -27.4698, longitude: 153.0251, priceCents: 60_000_000 }),
  L({ title: "Beach pad", suburb: "Surfers Paradise", address: "2 Esplanade", amenities: ["pool", "balcony"], latitude: -28.0027, longitude: 153.4306, priceCents: 120_000_000 }),
  L({ title: "No pin", suburb: "Paddington", description: "Charming cottage", amenities: ["garden"] })
];
const titles = (qq: SearchQuery) => searchInMemory(data, qq).items.map(l => l.title).sort();

describe("search text", () => {
  it("splits into lower-case words, drops symbols and caps the count", () => {
    expect(searchWords("  Pool-House, 3 Bed!! ")).toEqual(["pool", "house", "3", "bed"]);
    expect(searchWords("a b c d e f g h i j k")).toHaveLength(8);
    expect(searchWords("!!! ???")).toEqual([]);
  });
  it("is read from q and ignored when blank, symbol only or too long", () => {
    expect(p({ q: " pool " }).q).toBe("pool");
    expect(p({ q: "   " }).q).toBeUndefined();
    expect(p({ q: "!!!" }).q).toBeUndefined();
    expect(p({ q: "x".repeat(101) }).q).toBeUndefined();
  });
  it("needs every word to start a word in title, address, suburb or description", () => {
    expect(titles(q({ q: "pool" }))).toEqual(["Pool house"]);
    expect(titles(q({ q: "latrobe paddington" }))).toEqual(["Pool house"]);
    expect(titles(q({ q: "salt" }))).toEqual(["Pool house"]);
    expect(titles(q({ q: "cottage" }))).toEqual(["No pin"]);
    expect(titles(q({ q: "pool cottage" }))).toEqual([]);
    expect(titles(q({ q: "ool" }))).toEqual([]);
  });
});

describe("amenities", () => {
  it("keeps known names in the fixed order and drops the rest", () => {
    expect(p({ amenities: "solar,jacuzzi,pool" }).amenities).toEqual(["pool", "solar"]);
    expect(p({ amenities: "jacuzzi" }).amenities).toBeUndefined();
  });
  it("requires every chosen amenity", () => {
    expect(titles(q({ amenities: ["pool"] }))).toEqual(["Beach pad", "Pool house"]);
    expect(titles(q({ amenities: ["pool", "garage"] }))).toEqual(["Pool house"]);
    expect(titles(q({ amenities: ["lift", "pool"] }))).toEqual([]);
  });
  it("validates owner input against the fixed list", () => {
    expect(parseDetails({ amenities: ["pool", "solar", "pool"] }, "sale")).toEqual({ ok: true, value: { amenities: ["pool", "solar"] } });
    expect(parseDetails({ amenities: [] }, "sale")).toEqual({ ok: true, value: { amenities: null } });
    expect(parseDetails({ amenities: ["moat"] }, "sale").ok).toBe(false);
    expect(parseDetails({ amenities: "pool" }, "sale").ok).toBe(false);
  });
  it("the database list matches the code list", () => {
    const sql = readFileSync("db/20261105100000_listing_search.sql", "utf8");
    const check = sql.slice(sql.indexOf("<@ ARRAY["), sql.indexOf("]::text[]"));
    const listed = [...check.matchAll(/'([a-z_]+)'/g)].map(m => m[1]!);
    expect([...new Set(listed)].sort()).toEqual([...AMENITIES].sort());
  });
});

describe("radius", () => {
  const q0 = { lat: "-27.4698", lng: "153.0251" };
  it("needs all three values, inside Australia, radius 1 to 100 km", () => {
    expect(p({ ...q0, radiusKm: "10" }).near).toEqual({ latitude: -27.4698, longitude: 153.0251, radiusKm: 10 });
    expect(p({ ...q0 }).near).toBeUndefined();
    expect(p({ ...q0, radiusKm: "0" }).near).toBeUndefined();
    expect(p({ ...q0, radiusKm: "101" }).near).toBeUndefined();
    expect(parseNear("51.5", "-0.12", "10")).toBeUndefined();
    expect(parseNear("abc", "153", "10")).toBeUndefined();
  });
  it("measures great-circle distance", () => {
    expect(distanceKm(-27.4698, 153.0251, -27.4698, 153.0251)).toBe(0);
    expect(distanceKm(-27.4698, 153.0251, -33.8688, 151.2093)).toBeGreaterThan(730);
    expect(distanceKm(-27.4698, 153.0251, -33.8688, 151.2093)).toBeLessThan(740);
  });
  it("keeps listings inside the circle and leaves out ones with no pin", () => {
    expect(titles(q({ near: { latitude: -27.4698, longitude: 153.0251, radiusKm: 10 } }))).toEqual(["City unit", "Pool house"]);
    expect(titles(q({ near: { latitude: -27.4698, longitude: 153.0251, radiusKm: 100 } }))).toEqual(["Beach pad", "City unit", "Pool house"]);
  });
  it("sorts nearest first, and falls back to newest without a point", () => {
    const near = { latitude: -27.4698, longitude: 153.0251, radiusKm: 100 };
    expect(searchInMemory(data, q({ near, sort: "distance" })).items.map(l => l.title)).toEqual(["City unit", "Pool house", "Beach pad"]);
    expect(p({ sort: "distance" }).sort).toBe("newest");
    expect(p({ ...q0, radiusKm: "5", sort: "distance" }).sort).toBe("distance");
  });
  it("the search box fully contains the circle", () => {
    const b = bboxAround({ latitude: -27.4698, longitude: 153.0251, radiusKm: 50 });
    expect(distanceKm(-27.4698, 153.0251, b.north, 153.0251)).toBeGreaterThanOrEqual(49.9);
    expect(b.west).toBeLessThan(153.0251 - 0.4);
  });
});

describe("SQL", () => {
  it("passes every user value as a parameter", () => {
    const evil = "x'); DROP TABLE property_listing; --";
    const b = buildSearch(q({ q: evil, amenities: ["pool"], near: { latitude: -27.4, longitude: 153, radiusKm: 5 }, sort: "distance" }));
    expect(b.where).not.toContain("DROP");
    expect(b.orderBy).not.toContain("DROP");
    expect(b.params).toContain("x:* & drop:* & table:* & property:* & listing:*");
    expect(b.where).toContain("@@ to_tsquery('simple'");
    expect(b.where).toContain("l.amenities @>");
    expect(b.orderBy).toContain("asin");
  });
  it("uses newest order for the distance sort when no point is given", () => {
    expect(buildSearch(q({ sort: "distance" })).orderBy).toBe("l.created_at DESC, l.id DESC");
  });
});
