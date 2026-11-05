import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPTIMIZATION_SETTINGS, SUGGESTION_TYPES, generateSuggestions, parseOptimizationSettings, type ListingFacts, type PriceFacts
} from "../src/domain/listing-optimization";

const S = DEFAULT_OPTIMIZATION_SETTINGS;
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const good = (o: Partial<ListingFacts> = {}): ListingFacts => ({
  transactionType: "sale", propertyType: "house", description: words(80), priceCents: 100_000_000, bedrooms: 3, bathrooms: 2, parking: 1, suburb: "Paddington", postcode: "4064", amenities: [],
  photos: { visibleCount: 10, floorplans: 1, lowResCount: 0, categories: { exterior: 2, living: 2, kitchen: 2, bedroom: 2, bathroom: 2 }, captioned: 10, hasTour: false }, ...o
});
const price = (o: Partial<PriceFacts> = {}): PriceFacts => ({ medianCents: 100_000_000, balancedCents: 100_000_000, sample: 12, ...o });
const types = (f: ListingFacts, p?: PriceFacts, s = S) => generateSuggestions(f, p, s).map(x => x.type);

describe("generateSuggestions", () => {
  it("finds nothing to say about a complete, fairly priced listing", () => {
    expect(generateSuggestions(good(), price(), S)).toEqual([]);
  });
  it("asks for photos when there are too few, and when there are none", () => {
    const few = generateSuggestions(good({ photos: { ...good().photos, visibleCount: 3 } }), undefined, S).find(x => x.type === "add_photos")!;
    expect(few.description).toMatch(/3 photos/);
    const none = generateSuggestions(good({ photos: { visibleCount: 0, floorplans: 0, lowResCount: 0, categories: {}, captioned: 0, hasTour: false } }), undefined, S);
    expect(none.find(x => x.type === "add_photos")!.description).toMatch(/no photos/);
    expect(none.map(x => x.type)).not.toContain("photo_gaps");
  });
  it("uses the staff threshold for the number of photos", () => {
    const f = good({ photos: { ...good().photos, visibleCount: 9 } });
    expect(types(f)).not.toContain("add_photos");
    expect(types(f, undefined, { ...S, minPhotos: 12 })).toContain("add_photos");
  });
  it("names the rooms with no photo, including a pool the owner ticked", () => {
    const f = good({ amenities: ["pool"], photos: { ...good().photos, categories: { exterior: 3, living: 3, kitchen: 2, bedroom: 2 } } });
    const d = generateSuggestions(f, undefined, S).find(x => x.type === "photo_gaps")!.description;
    expect(d).toMatch(/bathrooms and pool/);
  });
  it("asks the seller to sort photos by room when none is sorted", () => {
    const f = good({ photos: { ...good().photos, categories: { "": 10 } } });
    expect(generateSuggestions(f, undefined, S).find(x => x.type === "photo_gaps")!.description).toMatch(/not sorted by room/);
  });
  it("flags small photos, missing captions and a missing floorplan", () => {
    const f = good({ photos: { ...good().photos, lowResCount: 2, captioned: 2, floorplans: 0 } });
    expect(types(f)).toEqual(expect.arrayContaining(["photo_resolution", "photo_captions", "add_floorplan"]));
    expect(types(good({ propertyType: "land", photos: { ...good().photos, floorplans: 0 } }))).not.toContain("add_floorplan");
  });
  it("asks for a longer description and for ticked features it does not mention", () => {
    expect(types(good({ description: words(10) }))).toContain("expand_description");
    expect(types(good({ description: undefined }))).toContain("expand_description");
    const f = good({ amenities: ["pool", "solar", "garden"], description: `${words(80)} A sparkling pool out the back.` });
    const d = generateSuggestions(f, undefined, S).find(x => x.type === "highlight_features")!.description;
    expect(d).toMatch(/solar panels and the garden/);
    expect(d).not.toMatch(/the pool/);
  });
  it("lists missing details, and skips bedrooms for land", () => {
    const d = generateSuggestions(good({ bedrooms: undefined, parking: undefined, priceCents: undefined }), undefined, S).find(x => x.type === "complete_details")!.description;
    expect(d).toMatch(/bedrooms, parking and price/);
    expect(types(good({ propertyType: "land", bedrooms: undefined, bathrooms: undefined, parking: undefined }))).not.toContain("complete_details");
  });

  describe("price", () => {
    it("suggests a cut to the balanced figure when asking is well above it", () => {
      const s = generateSuggestions(good({ priceCents: 106_000_000 }), price({ balancedCents: 100_000_000, medianCents: 99_000_000 }), S).find(x => x.type === "lower_price")!;
      expect(s.description).toMatch(/about 5\.7%/);
      expect(s.description).toMatch(/\$1,000,000/);
      expect(s.impact.offersPercent.low).toBeGreaterThan(0);
      expect(s.impact.viewsPercent.high).toBeGreaterThanOrEqual(s.impact.viewsPercent.low);
    });
    it("caps the cut at the staff limit and says so", () => {
      const s = generateSuggestions(good({ priceCents: 150_000_000 }), price(), { ...S, maxPriceCutPercent: 5 }).find(x => x.type === "lower_price")!;
      expect(s.description).toMatch(/about 5%/);
      expect(s.description).toMatch(/capped at 5%/);
    });
    it("stays quiet when asking is within 3% of the balanced figure, or under it", () => {
      expect(types(good({ priceCents: 102_900_000 }), price())).not.toContain("lower_price");
      expect(types(good({ priceCents: 90_000_000 }), price())).not.toContain("lower_price");
    });
    it("never suggests a price without enough sales, for rentals, or with no market data", () => {
      expect(types(good({ priceCents: 150_000_000 }), price({ sample: 2 }))).not.toContain("lower_price");
      expect(types(good({ priceCents: 150_000_000, transactionType: "rent" }), price())).not.toContain("lower_price");
      expect(types(good({ priceCents: 150_000_000 }), undefined)).not.toContain("lower_price");
    });
    it("mentions a falling market", () => {
      const s = generateSuggestions(good({ priceCents: 110_000_000 }), price({ trend: "down" }), S).find(x => x.type === "lower_price")!;
      expect(s.description).toMatch(/drifting down/);
    });
  });

  it("leaves out types staff have turned off", () => {
    const f = good({ photos: { ...good().photos, visibleCount: 2 }, description: words(5) });
    expect(types(f, undefined, { ...S, disabledTypes: ["add_photos"] })).not.toContain("add_photos");
    expect(types(f, undefined, { ...S, disabledTypes: ["add_photos"] })).toContain("expand_description");
  });
  it("ranks by likely impact, biggest first, and labels every impact as an estimate", () => {
    const out = generateSuggestions(good({ photos: { ...good().photos, visibleCount: 2, captioned: 0 }, description: words(5) }), undefined, S);
    expect(out[0]!.type).toBe("add_photos");
    const pr = out.map(x => x.priority);
    expect(pr).toEqual([...pr].sort((a, b) => b - a));
    expect(out.every(x => /not measured/.test(x.impact.basis))).toBe(true);
  });
  it("only ever returns known types", () => {
    const out = generateSuggestions(good({ priceCents: 150_000_000, bedrooms: undefined, description: words(3), amenities: ["pool"], photos: { visibleCount: 1, floorplans: 0, lowResCount: 1, categories: {}, captioned: 0, hasTour: false } }), price(), S);
    expect(out.every(x => (SUGGESTION_TYPES as readonly string[]).includes(x.type))).toBe(true);
    expect(new Set(out.map(x => x.type)).size).toBe(out.length);
  });
});

describe("parseOptimizationSettings", () => {
  it("keeps unsent fields and accepts valid ones", () => {
    const r = parseOptimizationSettings({ enabled: true, minPhotos: 12, disabledTypes: ["lower_price", "add_photos"] }, S);
    expect(r).toEqual({ ok: true, value: { ...S, enabled: true, minPhotos: 12, disabledTypes: ["add_photos", "lower_price"] } });
  });
  it("rejects out-of-range numbers, non-integers, non-booleans and unknown types", () => {
    for (const body of [{ minPhotos: 2 }, { minPhotos: 41 }, { minDescriptionWords: 19 }, { maxPriceCutPercent: 21 }, { maxPriceCutPercent: 2.5 }, { enabled: "yes" }, { disabledTypes: ["nope"] }, { disabledTypes: "add_photos" }]) {
      expect(parseOptimizationSettings(body, S).ok).toBe(false);
    }
  });
});
