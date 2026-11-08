import { describe, expect, it } from "vitest";
import { extractFeatures } from "../src/domain/listing-features-extract";

describe("extractFeatures", () => {
  it("reads the example description", () => {
    const f = extractFeatures("4 bedroom 3 toilet with pool and air conditioning");
    expect(f).toEqual({ bedrooms: 4, bathrooms: 3, amenities: ["pool", "air_conditioning"] });
  });
  it("reads parking and implies garage", () => {
    expect(extractFeatures("6 garage")).toMatchObject({ parking: 6, amenities: ["garage"] });
    expect(extractFeatures("Two car spaces, 3 bed 2 bath")).toMatchObject({ parking: 2, bedrooms: 3, bathrooms: 2 });
    expect(extractFeatures("double garage").parking).toBe(2);
  });
  it("handles words, hyphens and extras", () => {
    const f = extractFeatures("Four-bedroom home, ensuite, study, solar panels, pets allowed, unfurnished");
    expect(f.bedrooms).toBe(4);
    expect(f.amenities).toEqual(["solar", "pet_friendly", "ensuite", "study"]);
  });
  it("states nothing when the text does not", () => {
    expect(extractFeatures("Lovely quiet street")).toEqual({ amenities: [] });
  });
});

import { featureMismatches } from "../src/domain/listing-features-extract";
describe("featureMismatches", () => {
  const cur = { bedrooms: "5", bathrooms: "3", parking: "", amenities: [] as string[] };
  it("warns when the box disagrees with the description", () => {
    const m = featureMismatches("4 bedroom 3 toilet with pool", cur);
    expect(m.map(x => x.field)).toEqual(["bedrooms", "amenity"]);
    expect(m[0]?.message).toContain("says 4 bedrooms but the box says 5");
  });
  it("is quiet when everything agrees and flags conflicting counts", () => {
    expect(featureMismatches("4 bedroom", { ...cur, bedrooms: "4" })).toEqual([]);
    expect(featureMismatches("3 bed and 4 bedroom", { ...cur, bedrooms: "3" }).some(x => x.message.includes("different bedroom"))).toBe(true);
  });
});
