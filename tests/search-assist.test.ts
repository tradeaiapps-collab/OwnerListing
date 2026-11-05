import { describe, expect, it } from "vitest";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";
import type { SearchQuery } from "../src/domain/listing-search";
import type { PublicListing } from "../src/domain/listing-service";
import { analyseListings, explainSearchFeature, interpretSearch, narrate, narrationOk, relaxations } from "../src/domain/search-assist";

const I = (s: string) => interpretSearch(s).params;

describe("interpretSearch", () => {
  it("reads rooms, type, price, place and features from a sentence", () => {
    expect(I("3 bed house in Paddington under 900k with a pool")).toEqual({
      minBedrooms: "3", propertyType: "house", maxPriceCents: "90000000", transactionType: "sale", suburb: "Paddington", amenities: "pool"
    });
  });
  it("treats small prices and the word rent as weekly rent", () => {
    expect(I("2 bedroom unit to rent under $650 a week in West End")).toMatchObject({ transactionType: "rent", maxPriceCents: "65000", propertyType: "unit", minBedrooms: "2", suburb: "West End" });
    expect(I("apartment under 700")).toMatchObject({ transactionType: "rent", maxPriceCents: "70000" });
  });
  it("reads ranges and minimums", () => {
    expect(I("between $500k and $800k")).toMatchObject({ minPriceCents: "50000000", maxPriceCents: "80000000", transactionType: "sale" });
    expect(I("500-800k")).toMatchObject({ minPriceCents: "50000000", maxPriceCents: "80000000" });
    expect(I("over 1.2m")).toMatchObject({ minPriceCents: "120000000" });
    expect(I("$850,000")).toMatchObject({ maxPriceCents: "85000000" });
  });
  it("tells a postcode from a price", () => {
    expect(I("house in 4064")).toEqual({ propertyType: "house", postcode: "4064" });
    expect(I("under 1500 a week")).toMatchObject({ transactionType: "rent", maxPriceCents: "150000" });
    expect(I("4064 under 900k")).toMatchObject({ postcode: "4064", maxPriceCents: "90000000" });
  });
  it("reads states, baths, parking and several features", () => {
    expect(I("2 bath 2 car townhouse in QLD with solar, air con and a study")).toMatchObject({
      minBathrooms: "2", minParking: "2", propertyType: "townhouse", jurisdiction: "QLD", amenities: "air_conditioning,solar,study"
    });
  });
  it("does not read bedroom counts as a price and ignores nonsense", () => {
    expect(I("4 bedrooms")).toEqual({ minBedrooms: "4" });
    expect(interpretSearch("hello there").params).toEqual({});
    expect(interpretSearch("").understood).toEqual([]);
    expect(I("0 bed 99 bath")).toEqual({});
  });
  it("lists what it understood in words and only ever returns URL filter names", () => {
    const r = interpretSearch("3 bed house in Paddington under 900k");
    expect(r.understood).toEqual(["For sale", "3+ bedrooms", "up to $900,000", "House", "Paddington"]);
    const known = ["transactionType", "minPriceCents", "maxPriceCents", "propertyType", "minBedrooms", "minBathrooms", "minParking", "amenities", "jurisdiction", "postcode", "suburb"];
    for (const k of Object.keys(I("3 bed 2 bath 1 car house in Bulimba qld under 2m with pool"))) expect(known).toContain(k);
  });
  it("is safe on long and odd input", () => {
    expect(() => interpretSearch("9".repeat(5000) + " <script>alert(1)</script> $$$ -- ,,, k m")).not.toThrow();
    expect(I("<script>alert(1)</script>")).toEqual({});
  });
});

let n = 0;
const L = (o: Partial<PublicListing>): PublicListing => {
  n += 1;
  return { id: `x-${n}`, jurisdiction: "QLD", status: "published", title: `Home ${n}`, propertyType: "house", useClass: "residential", transactionType: "sale", address: "a",
    disclosures: [], createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...o };
};

describe("analyseListings", () => {
  const ls = [
    L({ title: "A", priceCents: 60_000_000, bedrooms: 2, suburb: "Paddington", amenities: ["pool"] }),
    L({ title: "B", priceCents: 90_000_000, bedrooms: 4, suburb: "Paddington", amenities: ["pool", "solar"] }),
    L({ title: "C", priceCents: 120_000_000, bedrooms: 3, suburb: "Bulimba", propertyType: "unit" }),
    L({ title: "D" })
  ];
  const a = analyseListings(ls, 4);
  it("gives count, price spread and per-bedroom median over listings that state a price", () => {
    expect(a.count).toBe(4);
    expect(a.prices).toMatchObject({ transactionType: "sale", count: 3, minCents: 60_000_000, medianCents: 90_000_000, maxCents: 120_000_000 });
    expect(a.prices?.medianPerBedroomCents).toBe(30_000_000);
  });
  it("tallies types, suburbs and features", () => {
    expect(a.byType[0]).toEqual({ propertyType: "house", count: 3 });
    expect(a.topSuburbs[0]).toEqual({ suburb: "Paddington", count: 2 });
    expect(a.commonAmenities[0]).toEqual({ amenity: "pool", count: 2 });
  });
  it("names standouts only when one listing clearly leads", () => {
    expect(a.standouts.map(s => `${s.label}:${s.title}`)).toEqual(["Lowest price:A", "Most bedrooms:B"]);
    const tie = analyseListings([L({ priceCents: 5, bedrooms: 2 }), L({ priceCents: 5, bedrooms: 2 })], 2);
    expect(tie.standouts).toEqual([]);
  });
  it("says so when the figures are partial", () => {
    expect(a.notes).toContain("1 listing did not state a price and is left out of the price figures.");
    expect(analyseListings(ls, 40).notes).toContain("Figures cover the first 4 of 40 matching listings.");
    expect(analyseListings([L({ priceCents: 1 })], 1).notes).toContain("Too few listings state a price to show a price range.");
    expect(analyseListings([L({ priceCents: 1 }), L({ priceCents: 2, transactionType: "rent" })], 2).notes[0]).toContain("both sales and rentals");
  });
  it("handles no results and finds the closest listing around a point", () => {
    expect(analyseListings([], 0).text).toBe("No listings match these filters.");
    const near = { latitude: -27.47, longitude: 153.02, radiusKm: 50 };
    const c = analyseListings([L({ title: "Far", latitude: -27.9, longitude: 153.4 }), L({ title: "Close", latitude: -27.46, longitude: 153.01 })], 2, near);
    expect(c.standouts.find(s => s.label === "Closest")?.title).toBe("Close");
  });
  it("writes facts only, never advice or valuation", () => {
    expect(a.text).toContain("Asking prices range from $600,000 to $1,200,000, with a middle value of $900,000.");
    expect(a.text).not.toMatch(/should|recommend|bargain|good deal|worth|overpriced/i);
  });
});

describe("relaxations", () => {
  it("offers one variant per active filter, each without that filter", () => {
    const q: SearchQuery = { sort: "newest", page: 3, pageSize: 12, q: "pool", minBedrooms: 4, suburb: "Pad", maxPriceCents: 5, amenities: ["pool"], propertyType: "house" };
    const r = relaxations(q);
    expect(r.map(x => x.label)).toEqual(["the search words", "the suburb or postcode", "the price range", "the bedroom minimum", "the features", "the property type"]);
    expect(r[0]!.query.q).toBeUndefined();
    expect(r[0]!.query.minBedrooms).toBe(4);
    expect(r.every(x => x.query.page === 1 && x.query.pageSize === 1)).toBe(true);
    expect(relaxations({ sort: "newest", page: 1, pageSize: 12 })).toEqual([]);
  });
});

describe("explainSearchFeature", () => {
  it("answers by topic and falls back to an overview", () => {
    expect(explainSearchFeature("how do I compare homes?").answers.map(a => a.id)).toEqual(["compare"]);
    expect(explainSearchFeature("can I get an email alert when something new is listed").answers.map(a => a.id)).toContain("saved_searches");
    expect(explainSearchFeature("what is the radius filter").answers[0]?.id).toBe("radius");
    const none = explainSearchFeature("zzz");
    expect(none.answers).toEqual([]);
    expect(none.overview.length).toBeGreaterThan(20);
  });
});

describe("narrate", () => {
  const facts = "3 listings match. Asking prices range from $600,000 to $1,200,000, with a middle value of $900,000.";
  const engine = (out: string | Error): AiEnginePort => ({ ...rulesOnlyEngine, info: () => ({ id: "t", kind: "self_hosted", version: "1" }), generate: async () => { if (out instanceof Error) throw out; return out; } });
  it("accepts wording that keeps to the facts", async () => {
    expect(await narrate(engine("Three listings match, from $600,000 to $1,200,000."), facts)).toBe("Three listings match, from $600,000 to $1,200,000.");
  });
  it("drops text with a new number, advice, valuation, a link or an email", () => {
    for (const bad of ["Prices start at $550,000.", "You should buy the cheapest one.", "A bargain at $600,000.", "See https://example.com", "Email a@b.co", "It will rise 5%", ""]) {
      expect(narrationOk(bad, facts)).toBe(false);
    }
    expect(narrationOk("Prices run from $600,000 to $1,200,000 and the middle is $900,000.", facts)).toBe(true);
  });
  it("returns nothing when AI is off, empty, or throws", async () => {
    expect(await narrate(rulesOnlyEngine, facts)).toBeUndefined();
    expect(await narrate(engine("x"), "")).toBeUndefined();
    expect(await narrate(engine(new Error("down")), facts)).toBeUndefined();
  });
});
