import { describe, expect, it } from "vitest";
import { cleanFilename, sameFilename } from "../src/domain/file-names";
import { checkRealText, GIBBERISH_MESSAGE } from "../src/domain/text-quality";
import { reviewListing } from "../src/domain/listing-validation";

describe("file names", () => {
  it("keeps the base name only and compares case-insensitively", () => {
    expect(cleanFilename("C:\\Users\\me\\Front.JPG")).toBe("Front.JPG");
    expect(cleanFilename("a/b/\u0000x.png ")).toBe("x.png");
    expect(cleanFilename(undefined)).toBe("");
    expect(sameFilename("Front.JPG", "front.jpg")).toBe(true);
    expect(sameFilename("", "")).toBe(false);
  });
});

describe("checkRealText", () => {
  it("accepts real writing and blank text", () => {
    expect(checkRealText("")).toBeNull();
    expect(checkRealText("Sunny three bedroom home with a renovated kitchen and a large backyard, close to the train station.")).toBeNull();
    expect(checkRealText("Outdoors: Fenced garden with a covered deck.\nNearby: Schools, shops and the beach.\nRecent work: New roof in 2024.")).toBeNull();
    expect(checkRealText("Property with strengths in a rhythm of rooms, 4 bed 2 bath")).toBeNull();
  });
  it("rejects keyboard mash, repeated characters, no-vowel words and repeats", () => {
    for (const t of ["asdfghjkl qwertyuiop", "aaaaaaa bbbbbbb", "hhhh gggg jjjj", "xcvbnm zxcvbnm lkjhgf", "test test test test test test test", "a", "sdfsdf sdfsdf", "bcdfg hjklm npqrst"]) {
      expect(checkRealText(t), t).toBe(GIBBERISH_MESSAGE);
    }
  });
  it("names the labelled part that is gibberish", () => {
    expect(checkRealText("A lovely family home near the park.\nOutdoors: asdfgh jkl")).toContain('"Outdoors"');
  });
  it("lets a draft save a one-word note but not mash", () => {
    expect(checkRealText("Land", 0)).toBeNull();
    expect(checkRealText("kjhgfdsa", 0)).not.toBeNull();
  });
  it("blocks publishing in Elena's review", () => {
    const l = { id: "1", title: "A good title", address: "1 A St", description: "asdfghjkl qwertyuiop zxcvbnm", propertyType: "house", transactionType: "sale", useClass: "residential", suburb: "X", postcode: "4000", priceCents: 100, bedrooms: 1, bathrooms: 1, parking: 1, amenities: [] } as never;
    const r = reviewListing({ listing: l, photos: { photos: [], floorplans: 0 }, wordingFlags: [], clearedWording: new Set(), gateReasons: [] });
    expect(r.findings.some(f => f.id === "description-gibberish" && f.severity === "block")).toBe(true);
  });
});

import { checkElenaInput } from "../src/domain/text-quality";
import { PROFANITY_MESSAGE } from "../src/domain/profanity-filter";

describe("checkElenaInput (notes box and Elena chat)", () => {
  it("allows blank text, real notes and short real questions", () => {
    expect(checkElenaInput("")).toBeNull();
    expect(checkElenaInput("Renovated in 2022, walk to the train station, quiet street.")).toBeNull();
    expect(checkElenaInput("What are rates?")).toBeNull();
    expect(checkElenaInput("stamp duty")).toBeNull();
  });
  it("blocks profanity with the standard message", () => {
    expect(checkElenaInput("this house is a piece of shit")).toBe(PROFANITY_MESSAGE);
    expect(checkElenaInput("wtf")).toBe(PROFANITY_MESSAGE);
  });
  it("blocks gibberish with the standard message", () => {
    expect(checkElenaInput("asdfghjkl")).toBe(GIBBERISH_MESSAGE);
    expect(checkElenaInput("kkkkkkk lllllll")).toBe(GIBBERISH_MESSAGE);
  });
});
