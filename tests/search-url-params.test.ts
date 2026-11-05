import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../src/domain/listing-search";
import { BLANK_FILTERS, filterParams, formFromQuery } from "../app/listings/url-params";

const q = (o: Record<string, string>) => parseSearchQuery(new URLSearchParams(o));

describe("filter form and URL", () => {
  it("round trips every filter through the address bar", () => {
    const form = { ...BLANK_FILTERS, transactionType: "sale", propertyType: "house", location: "Paddington", minPrice: "500000", maxPrice: "900,000.50".replace(",", ""),
      minBedrooms: "3", q: " saltwater pool ", amenities: "pool,solar", lat: "-27.47", lng: "153.02", radiusKm: "10" };
    const back = parseSearchQuery(filterParams(form));
    expect(back).toMatchObject({ transactionType: "sale", propertyType: "house", suburb: "Paddington", minPriceCents: 50_000_000, maxPriceCents: 90_000_050,
      minBedrooms: 3, q: "saltwater pool", amenities: ["pool", "solar"], near: { latitude: -27.47, longitude: 153.02, radiusKm: 10 } });
    expect(filterParams(formFromQuery(back)).toString()).toBe(filterParams({ ...form, q: "saltwater pool" }).toString());
  });
  it("leaves blank filters out", () => {
    expect(filterParams(BLANK_FILTERS).toString()).toBe("");
  });
  it("reads a postcode into the location box and cents into dollars", () => {
    const f = formFromQuery(q({ postcode: "4064", transactionType: "rent", maxPriceCents: "65050" }));
    expect(f).toMatchObject({ location: "4064", maxPrice: "650.50", transactionType: "rent" });
  });
});
