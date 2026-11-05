import { describe, expect, it } from "vitest";
import { compareProperties, parseCompareIds } from "../src/domain/listing-compare";
import type { PublicListing } from "../src/domain/listing-service";

let n = 0;
const L = (over: Partial<PublicListing>): PublicListing => {
  n += 1;
  return { id: `id-${n}`, jurisdiction: "QLD", status: "published", title: `Home ${n}`, propertyType: "house", useClass: "residential", transactionType: "sale",
    address: "1 Test St", disclosures: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over };
};
const row = (c: ReturnType<typeof compareProperties>, key: string) => c.rows.find(r => r.key === key)!;
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

describe("parseCompareIds", () => {
  it("accepts 2 to 4 distinct ids", () => {
    expect(parseCompareIds(`${A},${B}`)).toEqual([A, B]);
    expect(parseCompareIds(`${A},${B},${A}`)).toEqual([A, B]);
    expect(parseCompareIds(` ${A.toUpperCase()} , ${B} `)).toEqual([A, B]);
  });
  it("refuses fewer than 2, more than 4, bad ids and nothing", () => {
    expect(parseCompareIds(A)).toBeUndefined();
    expect(parseCompareIds(`${A},${A}`)).toBeUndefined();
    expect(parseCompareIds(`${A},${B},${C},${A.replace("1", "4")},${B.replace("2", "5")}`)).toBeUndefined();
    expect(parseCompareIds(`${A},not-an-id`)).toBeUndefined();
    expect(parseCompareIds(null)).toBeUndefined();
    expect(parseCompareIds("")).toBeUndefined();
  });
});

describe("compareProperties", () => {
  const a = L({ title: "Pool house", priceCents: 90_000_000, bedrooms: 4, bathrooms: 2, parking: 2, suburb: "Paddington", postcode: "4064", amenities: ["pool", "garage"] });
  const b = L({ title: "City unit", propertyType: "unit", priceCents: 60_000_000, bedrooms: 2, bathrooms: 2, suburb: "Brisbane City", amenities: ["lift"] });
  const c = compareProperties([a, b]);

  it("marks the lowest price and the most rooms", () => {
    expect(row(c, "price").best).toEqual([1]);
    expect(row(c, "bedrooms").best).toEqual([0]);
    expect(row(c, "bathrooms").best).toEqual([]);
    expect(row(c, "price").values).toEqual(["$900,000", "$600,000"]);
  });
  it("works out price per bedroom", () => {
    expect(row(c, "perBedroom").values).toEqual(["$225,000", "$300,000"]);
    expect(row(c, "perBedroom").best).toEqual([0]);
  });
  it("says Not stated for blanks and does not rank them", () => {
    expect(row(c, "parking").values).toEqual(["2", "Not stated"]);
    expect(row(c, "parking").best).toEqual([]);
  });
  it("adds one row per amenity anyone has", () => {
    expect(row(c, "amenity:pool").values).toEqual(["Yes", "No"]);
    expect(row(c, "amenity:lift").values).toEqual(["No", "Yes"]);
    expect(c.rows.find(r => r.key === "amenity:solar")).toBeUndefined();
  });
  it("writes factual highlights and a summary from the numbers only", () => {
    expect(c.highlights).toContain("Lowest price: City unit at $600,000, $300,000 below the next.");
    expect(c.highlights).toContain("Most bedrooms: Pool house (4).");
    expect(c.highlights).toContain("Only Pool house lists pool.");
    expect(c.summary.startsWith("Comparing 2 properties:")).toBe(true);
    expect(c.summary).not.toMatch(/should|recommend|best buy|good deal/i);
  });
  it("compares rents per week", () => {
    const r = compareProperties([L({ transactionType: "rent", priceCents: 65_000, bedrooms: 2 }), L({ transactionType: "rent", priceCents: 80_000, bedrooms: 2 })]);
    expect(row(r, "price").label).toBe("Rent per week");
    expect(row(r, "price").values).toEqual(["$650 per week", "$800 per week"]);
    expect(r.highlights[0]).toBe("Lowest rent: Home 5 at $650 per week, $150 per week below the next.".replace("Home 5", r.highlights[0]!.match(/Lowest rent: (Home \d+)/)![1]!));
  });
  it("shows but does not rank prices when a sale and a rent are mixed", () => {
    const m = compareProperties([L({ priceCents: 90_000_000 }), L({ transactionType: "rent", priceCents: 65_000 })]);
    expect(m.comparablePrices).toBe(false);
    expect(row(m, "price").best).toEqual([]);
    expect(row(m, "price").values[1]).toBe("$650 per week");
    expect(m.highlights.some(h => h.includes("both a sale and a rental"))).toBe(true);
  });
  it("handles four listings, equal listings and listings with no price", () => {
    const same = compareProperties([L({ priceCents: 5, bedrooms: 3 }), L({ priceCents: 5, bedrooms: 3 })]);
    expect(same.summary).toContain("level on every figure");
    const four = compareProperties([L({}), L({}), L({}), L({})]);
    expect(four.rows[0]!.values).toEqual(Array(4).fill("Not stated"));
    expect(four.highlights).toContain("4 of 4 listings do not state a price.");
  });
});
