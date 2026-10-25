import { describe, expect, it } from "vitest";
import {
  categoryOf, flagKey, messageWordingError, scanFields, scanForDiscrimination, wordingBlockReasons, type DiscriminationCategory
} from "../src/domain/discrimination-filter";

/**
 * Labelled set for the G1 gate (House Listing Spec 6.4: at least 95% recall on discriminatory wording).
 * Phrases are written the way Australian listings and share-house ads actually phrase them: mixed case, punctuation, plurals,
 * slang and padding around the offending words. Add to this set whenever a miss is reported; never delete a phrase to pass.
 */
const MUST_BLOCK: readonly [string, DiscriminationCategory][] = [
  // Children, family, pregnancy
  ["No kids.", "familial_status"],
  ["NO KIDS OR PETS!!", "familial_status"],
  ["Sorry, no children", "familial_status"],
  ["no-kids household", "familial_status"],
  ["Kids are not allowed in this complex.", "familial_status"],
  ["Children not permitted", "familial_status"],
  ["Children will not be considered", "familial_status"],
  ["Not suitable for children", "familial_status"],
  ["Unsuitable for kids", "familial_status"],
  ["Adults only building", "familial_status"],
  ["Adult-only complex", "familial_status"],
  ["Child-free home", "familial_status"],
  ["Kid free zone, quiet street", "familial_status"],
  ["Couple without children preferred", "familial_status"],
  ["No babies or toddlers", "familial_status"],
  ["No families", "familial_status"],
  ["Families need not apply", "familial_status"],
  ["Must not be pregnant", "familial_status"],
  ["No plans for children please", "familial_status"],
  ["Not planning to have kids", "familial_status"],
  ["No single mums", "familial_status"],
  ["Single parents need not apply", "familial_status"],
  ["We won't rent to families", "familial_status"],
  ["Strictly adults", "familial_status"],
  ["No teenagers", "familial_status"],
  ["Not for families with kids", "familial_status"],
  ["Pregnant women not accepted", "familial_status"],
  // Age
  ["Over 55s only", "age"],
  ["over-50s only community", "age"],
  ["No retirees", "age"],
  ["Young professionals only", "age"],
  ["Mature tenants preferred", "age"],
  ["Mature aged couple wanted", "age"],
  ["No elderly", "age"],
  ["Seniors only", "age"],
  ["Under 30s only", "age"],
  ["Older couple preferred", "age"],
  ["No young people", "age"],
  ["Young couple wanted", "age"],
  ["Not suitable for the elderly", "age"],
  ["55+ only", "age"],
  // Race, nationality, ethnic origin
  ["No overseas buyers", "race"],
  ["no foreign buyers", "race"],
  ["Australians only", "race"],
  ["Aussies only please", "race"],
  ["Australian citizens only", "race"],
  ["Must be an Australian citizen", "race"],
  ["Must be a permanent resident", "race"],
  ["Citizens and permanent residents only", "race"],
  ["No Indians", "race"],
  ["Asian buyers preferred", "race"],
  ["Prefer Chinese tenants", "race"],
  ["Ideal for Chinese buyers", "race"],
  ["Perfect for Indian families", "race"],
  ["European tenants wanted", "race"],
  ["Must speak English", "race"],
  ["Must be able to speak fluent English", "race"],
  ["English speaking only", "race"],
  ["Fluent English essential", "race"],
  ["No foreigners", "race"],
  ["Not suitable for immigrants", "race"],
  ["No refugees", "race"],
  ["White tenants only", "race"],
  ["Asian area", "race"],
  ["Quiet Anglo neighbourhood", "race"],
  ["Locals only", "race"],
  ["No Aboriginals", "race"],
  ["Indigenous people need not apply", "race"],
  ["Lebanese family wanted", "race"],
  ["No Africans", "race"],
  ["Won't rent to Sudanese", "race"],
  ["Middle Eastern buyers not welcome", "race"],
  ["Non-Australians need not apply", "race"],
  ["No non residents", "race"],
  ["Kiwis not accepted", "race"],
  ["Looking for Vietnamese tenants", "race"],
  // Religion
  ["Christian household", "religion"],
  ["Christians only", "religion"],
  ["Christian family preferred", "religion"],
  ["No Muslims", "religion"],
  ["Muslim tenants preferred", "religion"],
  ["Jewish community, Jewish buyers only", "religion"],
  ["Ideal for Hindu family", "religion"],
  ["Catholic tenants wanted", "religion"],
  ["Not suitable for religious people", "religion"],
  ["Must be a Christian", "religion"],
  ["Seeking Buddhist housemate", "religion"],
  ["No atheists", "religion"],
  ["God-fearing family preferred", "religion"],
  ["Muslim area", "religion"],
  // Sex
  ["Female only", "sex"],
  ["Females only", "sex"],
  ["Male tenants only", "sex"],
  ["Female flatmate wanted", "sex"],
  ["Ladies only", "sex"],
  ["Gentlemen only house", "sex"],
  ["No males", "sex"],
  ["Girls only share house", "sex"],
  ["Prefer female", "sex"],
  ["Looking for a male housemate", "sex"],
  ["No men", "sex"],
  ["Women preferred", "sex"],
  ["Guys only", "sex"],
  // Sexuality, gender identity
  ["No gays", "sexuality_gender"],
  ["Straight couples only", "sexuality_gender"],
  ["Not suitable for LGBT", "sexuality_gender"],
  ["Homosexuals not welcome", "sexuality_gender"],
  ["No trans people", "sexuality_gender"],
  ["Heterosexual couple preferred", "sexuality_gender"],
  ["Lesbians need not apply", "sexuality_gender"],
  // Relationship status
  ["Married couples only", "relationship_status"],
  ["No couples", "relationship_status"],
  ["No singles", "relationship_status"],
  ["Single person only", "relationship_status"],
  ["Married couple preferred", "relationship_status"],
  ["No de facto couples", "relationship_status"],
  ["Couples only", "relationship_status"],
  ["Single professional only", "relationship_status"],
  ["Divorcees not accepted", "relationship_status"],
  // Disability
  ["Not suitable for disabled people", "disability"],
  ["No wheelchairs", "disability"],
  ["Disabled tenants not accepted", "disability"],
  ["Must be able-bodied", "disability"],
  ["No NDIS", "disability"],
  ["NDIS tenants need not apply", "disability"],
  ["No mental illness", "disability"],
  ["Must be physically fit", "disability"],
  ["No people with disabilities", "disability"],
  ["Not suitable for wheelchair users", "disability"],
  ["Handicapped persons not considered", "disability"],
  // Source of income
  ["No DSS", "income_source"],
  ["No Centrelink", "income_source"],
  ["No pensioners", "income_source"],
  ["Sorry no welfare", "income_source"],
  ["Pensioners need not apply", "income_source"],
  ["Unemployed people not considered", "income_source"],
  ["No housing commission tenants", "income_source"],
  ["DSS not accepted", "income_source"],
  ["No people on benefits", "income_source"],
  // Occupation (platform policy, spec 6.4 lists "suits professionals only")
  ["Suits professionals only", "occupation"],
  ["Professionals only", "occupation"],
  ["Working professionals preferred", "occupation"],
  ["No students", "occupation"],
  ["Students need not apply", "occupation"],
  ["Professional couple preferred", "occupation"],
  ["Working couple only", "occupation"],
  ["No backpackers", "occupation"],
  ["No international students", "occupation"],
  ["No tradies", "occupation"],
  ["FIFO workers only", "occupation"]
];

/** Advisory wording: flagged as a warning, never as a block. */
const MUST_WARN: readonly string[] = [
  "Perfect for families",
  "Ideal for a young family",
  "Suits a professional couple",
  "Great for retirees",
  "Ideal for students",
  "Not child-friendly",
  "Suit mature tenant",
  "Must be in full-time employment"
];

/** Ordinary listing wording, including traps that share words with the phrases above. None may be flagged. */
const MUST_PASS: readonly string[] = [
  "Renovated family home with pool",
  "Large family room and separate study",
  "Kids' playground across the road",
  "Close to schools, childcare and parks",
  "Pets and kids welcome",
  "Couples welcome",
  "International students welcome",
  "All applicants assessed on ability to pay",
  "No pets",
  "No smokers",
  "No parties",
  "No smoking inside",
  "Wheelchair accessible entry and bathroom",
  "Wheelchair-friendly ramp at the front",
  "No wheelchair access to the upper level",
  "Step-free entry, single-level living",
  "Walking distance to St Mary's Catholic church and school",
  "Close to the mosque, temple and shops",
  "Asian grocery and Italian restaurants nearby",
  "Indian Ocean views",
  "Foreign Investment Review Board (FIRB) approval may be required",
  "Foreign buyers may need FIRB approval",
  "Only 5 minutes to the beach",
  "Only a short walk to the train",
  "Single garage only",
  "Double garage with internal access",
  "Just a couple of minutes to the CBD",
  "Master bedroom with ensuite",
  "Granny flat ideal for extended family living",
  "Low-maintenance unit, lock up and leave",
  "Suits first home buyers and investors",
  "Ideal for downsizers",
  "Perfect family home in a quiet street",
  "Huge man cave in the shed",
  "No body corporate fees",
  "No stamp duty on off the plan purchases",
  "Mature trees and established gardens",
  "Children's bedroom with built-in robes",
  "Brisbane Boys College and Brisbane Girls Grammar nearby",
  "Close to the Jewish community centre",
  "Christian school within 2 km",
  "Crisp whites and natural timber throughout",
  "The original owners only lived here 5 years",
  "Air conditioning only in the living room",
  "Seller has owned the home for 30 years",
  "Over 20 years of loving care",
  "Bus to UQ for students and staff, 5 minutes",
  "Single-storey home on 600 sqm",
  "Ladies and gentlemen, this is the one",
  "Perfect for entertaining",
  "Ideal for working from home",
  "Separate parents' retreat upstairs",
  "No through traffic",
  "No strata levies",
  "The family home of 40 years is now for sale",
  "Suits a growing household",
  "Built for a modern lifestyle",
  "Close to the Greek Orthodox church",
  "Enjoy a quiet, mature garden",
  "Wanted: offers over $850,000"
];

describe("anti-discrimination wording filter: G1 recall gate", () => {
  it("blocks at least 95% of the labelled discriminatory phrases", () => {
    const missed = MUST_BLOCK.filter(([t]) => !scanForDiscrimination(t).blocked).map(([t]) => t);
    const recall = 1 - missed.length / MUST_BLOCK.length;
    expect(MUST_BLOCK.length).toBeGreaterThanOrEqual(150);
    // Missed phrases are listed in the failure message so they can be added to the rules.
    expect({ recall: recall >= 0.95, missed }).toEqual({ recall: true, missed: expect.any(Array) });
    expect(missed).toEqual([]);
  });

  it("puts each blocked phrase in the expected category", () => {
    const wrong = MUST_BLOCK
      .map(([t, c]) => ({ t, want: c, got: scanForDiscrimination(t).flags.filter(f => f.severity === "block").map(f => f.category) }))
      .filter(r => r.got.length > 0 && !r.got.includes(r.want));
    expect(wrong).toEqual([]);
  });

  it("warns, but does not block, on soft suitability wording", () => {
    for (const t of MUST_WARN) {
      const r = scanForDiscrimination(t);
      expect({ t, blocked: r.blocked, warned: r.flags.some(f => f.severity === "warn") }).toEqual({ t, blocked: false, warned: true });
    }
  });

  it("does not flag ordinary listing wording (false positives)", () => {
    const flagged = MUST_PASS.map(t => ({ t, flags: scanForDiscrimination(t).flags.map(f => f.match) })).filter(r => r.flags.length > 0);
    expect(flagged).toEqual([]);
  });
});

describe("scanForDiscrimination", () => {
  it("returns the exact span, message and a neutral suggestion", () => {
    const text = "Lovely 3 bed home. No kids. Close to shops.";
    const r = scanForDiscrimination(text);
    expect(r.blocked).toBe(true);
    expect(r.flags).toHaveLength(1);
    const f = r.flags[0]!;
    expect(text.slice(f.start, f.end)).toBe(f.match);
    expect(f.match).toBe("No kids");
    expect(f.category).toBe("familial_status");
    expect(f.message).toMatch(/excludes people/);
    expect(f.suggestion).toMatch(/Describe the property/);
  });

  it("handles curly quotes, dashes and non-breaking spaces without shifting offsets", () => {
    const text = "Lovely home — kids aren’t allowed. No DSS.";
    const r = scanForDiscrimination(text);
    expect(r.flags.map(f => f.match)).toEqual(["kids aren’t allowed", "No DSS"]);
    for (const f of r.flags) expect(text.slice(f.start, f.end)).toBe(f.match);
  });

  it("finds several flags in text order and merges overlaps (block wins over warn)", () => {
    const r = scanForDiscrimination("No young couples. Christians only. Perfect for families.");
    expect(r.flags.map(f => [f.match, f.severity])).toEqual([
      ["No young couples", "block"], ["Christians only", "block"], ["Perfect for families", "warn"]
    ]);
  });

  it("is case-insensitive and ignores extra spacing", () => {
    expect(scanForDiscrimination("nO    KiDs").blocked).toBe(true);
    expect(scanForDiscrimination("female   only").blocked).toBe(true);
  });

  it("returns no flags for empty text", () => {
    expect(scanForDiscrimination("")).toEqual({ flags: [], blocked: false });
  });

  it("scans a long description quickly (no catastrophic backtracking)", () => {
    const filler = "Spacious open plan living with timber floors and a modern kitchen. ".repeat(70);
    const started = performance.now();
    const r = scanForDiscrimination(`${filler} No kids. ${filler}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(r.flags.map(f => f.match)).toEqual(["No kids"]);
  });

  it("categorises by the protected words in a match", () => {
    expect(categoryOf("no DSS")).toBe("income_source");
    expect(categoryOf("Christian family")).toBe("religion");
    expect(categoryOf("lovely kitchen")).toBeUndefined();
  });
});

describe("field helpers", () => {
  it("scanFields skips empty fields and fields without flags", () => {
    const r = scanFields({ title: "Family home", description: "No pets. No kids.", notes: undefined, empty: "" });
    expect(r.map(f => [f.field, f.flags.map(x => x.match)])).toEqual([["description", ["No kids"]]]);
  });

  it("wordingBlockReasons lists blocking flags and skips warnings and staff-cleared matches", () => {
    const fields = scanFields({ title: "Over 55s only", description: "Perfect for families. No kids." });
    const reasons = wordingBlockReasons(fields);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toMatch(/^Wording in the title may be discriminatory: "Over 55s only"\./);
    expect(reasons[1]).toMatch(/description.*"No kids"/);
    const cleared = new Set([flagKey("title", "over  55S only")]);
    expect(wordingBlockReasons(fields, cleared)).toHaveLength(1);
  });

  it("flagKey is stable across case and spacing", () => {
    expect(flagKey("description", "No  Kids ")).toBe("description:no kids");
  });

  it("messageWordingError explains the first blocking phrase", () => {
    expect(messageWordingError("Hi, happy to show you through on Saturday.")).toBeUndefined();
    expect(messageWordingError("Perfect for families")).toBeUndefined();
    expect(messageWordingError("Sorry, we only rent to Australians only.")).toMatch(/can't be sent because ".*Australians only" may be discriminatory/);
  });
});
