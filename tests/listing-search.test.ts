import { describe, expect, it } from "vitest";
import { compareListings, parseSearchQuery, searchInMemory, type SearchQuery } from "../src/domain/listing-search";
import type { PropertyListing } from "../src/domain/listing";
import { buildSearch } from "../src/server/listing-search-sql";

let n = 0;
function L(over: Partial<PropertyListing>): PropertyListing {
  n += 1;
  return {
    id: `l-${String(n).padStart(2, "0")}`, ownerUserId: "o", ownerUserType: "owner", jurisdiction: "QLD", status: "published",
    title: `T${n}`, propertyType: "house", useClass: "residential", transactionType: "sale", address: "a", disclosures: [],
    createdAt: `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`, updatedAt: "2026-10-24T00:00:00.000Z", ...over
  };
}
const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ sort: "newest", page: 1, pageSize: 12, ...over });
const p = (o: Record<string, string>) => parseSearchQuery(new URLSearchParams(o));

const data = [
  L({ title: "cheap", priceCents: 50_000_000, bedrooms: 2, bathrooms: 1, parking: 0, suburb: "Paddington", postcode: "4064" }),
  L({ title: "mid", priceCents: 90_000_000, bedrooms: 3, bathrooms: 2, parking: 2, suburb: "Paddington", postcode: "4064" }),
  L({ title: "pricey", priceCents: 200_000_000, bedrooms: 5, bathrooms: 3, parking: 3, suburb: "Bulimba", postcode: "4171", propertyType: "unit" }),
  L({ title: "unpriced", suburb: "Paddo North", postcode: "4065" }),
  L({ title: "rental", transactionType: "rent", priceCents: 65_000, bedrooms: 2, suburb: "Paddington", postcode: "4064" }),
  L({ title: "draft", status: "draft", priceCents: 1, bedrooms: 9 })
];
const titles = (qq: SearchQuery) => searchInMemory(data, qq).items.map(l => l.title);

describe("parseSearchQuery", () => {
  it("defaults, and drops invalid values instead of failing", () => {
    expect(p({})).toEqual({ sort: "newest", page: 1, pageSize: 12 });
    expect(p({ jurisdiction: "XX", transactionType: "buy", sort: "random", page: "0", pageSize: "9999", minBedrooms: "-1", postcode: "12" }))
      .toEqual({ sort: "newest", page: 1, pageSize: 12 });
  });
  it("reads every filter", () => {
    expect(p({ jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "unit", minPriceCents: "1", maxPriceCents: "9", minBedrooms: "2", minBathrooms: "1", minParking: "1", suburb: " Pad ", postcode: "4064", sort: "price_asc", page: "3", pageSize: "5" }))
      .toEqual({ jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "unit", minPriceCents: 1, maxPriceCents: 9, minBedrooms: 2, minBathrooms: 1, minParking: 1, suburb: "Pad", postcode: "4064", sort: "price_asc", page: 3, pageSize: 5 });
  });
  it("ignores price filters unless sale or rent is chosen", () => {
    expect(p({ minPriceCents: "1", maxPriceCents: "9" })).toEqual({ sort: "newest", page: 1, pageSize: 12 });
  });
});

describe("filtering", () => {
  it("returns published only, newest first", () => {
    expect(titles(q())).toEqual(["rental", "unpriced", "pricey", "mid", "cheap"]);
  });
  it("filters by price range, inclusive, within sale", () => {
    expect(titles(q({ transactionType: "sale", minPriceCents: 50_000_000, maxPriceCents: 90_000_000, sort: "price_asc" }))).toEqual(["cheap", "mid"]);
    expect(titles(q({ transactionType: "rent", maxPriceCents: 70_000 }))).toEqual(["rental"]);
  });
  it("min bedrooms, bathrooms and parking exclude unknowns", () => {
    expect(titles(q({ minBedrooms: 3 }))).toEqual(["pricey", "mid"]);
    expect(titles(q({ minBathrooms: 2 }))).toEqual(["pricey", "mid"]);
    expect(titles(q({ minParking: 3 }))).toEqual(["pricey"]);
  });
  it("property type, suburb prefix (any case) and postcode", () => {
    expect(titles(q({ propertyType: "unit" }))).toEqual(["pricey"]);
    expect(titles(q({ suburb: "paddo" }))).toEqual(["unpriced"]);
    expect(titles(q({ suburb: "PADD", transactionType: "sale" }))).toEqual(["unpriced", "mid", "cheap"]);
    expect(titles(q({ postcode: "4171" }))).toEqual(["pricey"]);
  });
});

describe("sorting and pagination", () => {
  it("price sorts put unpriced last", () => {
    expect(titles(q({ transactionType: "sale", sort: "price_asc" }))).toEqual(["cheap", "mid", "pricey", "unpriced"]);
    expect(titles(q({ transactionType: "sale", sort: "price_desc" }))).toEqual(["pricey", "mid", "cheap", "unpriced"]);
    expect(titles(q({ sort: "bedrooms_desc" })).slice(0, 3)).toEqual(["pricey", "mid", "rental"]);
  });
  it("ties break the same way every time", () => {
    const a = L({ id: "a", createdAt: "2026-01-01T00:00:00.000Z", priceCents: 5 });
    const b = L({ id: "b", createdAt: "2026-01-01T00:00:00.000Z", priceCents: 5 });
    expect([a, b].sort(compareListings("price_asc")).map(l => l.id)).toEqual(["b", "a"]);
  });
  it("pages without overlap and reports the total", () => {
    const p1 = searchInMemory(data, q({ pageSize: 2 }));
    const p2 = searchInMemory(data, q({ pageSize: 2, page: 2 }));
    const p3 = searchInMemory(data, q({ pageSize: 2, page: 3 }));
    expect(p1.total).toBe(5);
    expect([...p1.items, ...p2.items, ...p3.items].map(l => l.title)).toEqual(["rental", "unpriced", "pricey", "mid", "cheap"]);
    expect(searchInMemory(data, q({ pageSize: 2, page: 4 })).items).toEqual([]);
  });
});

describe("buildSearch (SQL)", () => {
  it("puts every value in params and only placeholders in the SQL", () => {
    const evil = "x'; DROP TABLE property_listing; --";
    const { where, params } = buildSearch(q({ suburb: evil, postcode: "4064", transactionType: "sale", minPriceCents: 5, minBedrooms: 2 }));
    expect(where).not.toContain("DROP");
    expect(where).not.toContain("4064");
    expect(where).toMatch(/\$1\b.*\$2\b/);
    expect(params).toContain("sale");
    expect(params).toContain(5);
    expect(params.some(v => typeof v === "string" && v.includes("drop table"))).toBe(true);
    expect((where.match(/\$\d+/g) ?? []).length).toBe(params.length);
  });
  it("always restricts to published and escapes LIKE wildcards", () => {
    expect(buildSearch(q()).where).toBe("l.status = 'published'");
    expect(buildSearch(q({ suburb: "50%_a\\" })).params).toEqual(["50\\%\\_a\\\\%"]);
  });
  it("uses a fixed ORDER BY for each sort", () => {
    expect(buildSearch(q({ sort: "price_asc" })).orderBy).toContain("price_cents ASC NULLS LAST");
    expect(buildSearch(q({ sort: "price_desc" })).orderBy).toContain("price_cents DESC NULLS LAST");
  });
});
