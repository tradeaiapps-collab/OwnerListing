import { describe, expect, it } from "vitest";
import { scanFields } from "../src/domain/discrimination-filter";
import { countsIn, dollarAmountsIn, reviewListing, type ElenaInput } from "../src/domain/listing-validation";
import { createDraft, createInMemoryListingRepository, publishListing, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";

const photo = (o: Partial<ElenaInput["photos"]["photos"][number]> = {}) => ({ width: 1600, height: 1000, alt: "Front of the house", category: "", ...o });
const good = (over: Partial<ElenaInput> = {}, listing: { [K in keyof ElenaInput["listing"]]?: ElenaInput["listing"][K] | undefined } = {}): ElenaInput => ({
  listing: {
    id: "l1", title: "Renovated family home", address: "1 Example St", propertyType: "house", transactionType: "sale", useClass: "residential",
    suburb: "Paddington", postcode: "4064", priceCents: 85_000_000, bedrooms: 4, bathrooms: 2, parking: 2, amenities: ["pool"],
    description: "A renovated 4 bedroom home with 2 bathrooms, 2 car spaces and a pool, close to cafes and the train. Priced at $850,000.", ...(listing as object)
  },
  photos: { photos: [1, 2, 3, 4, 5].map(() => photo()), floorplans: 1 },
  wordingFlags: [], clearedWording: new Set(), gateReasons: [], ...over
});
const ids = (i: ElenaInput) => reviewListing(i).findings.map(f => f.id);

describe("parsers", () => {
  it("reads counts and dollar amounts", () => {
    expect(countsIn("Four-bed, 3 bathrooms and 2 car spaces", "bed")).toEqual([4]);
    expect(countsIn("Four-bed, 3 bathrooms and 2 car spaces", "bath")).toEqual([3]);
    expect(countsIn("Four-bed, 3 bathrooms and 2 car spaces", "car")).toEqual([2]);
    expect(dollarAmountsIn("$850,000 or $1.2m, rates $2,100 and $650 per week")).toEqual([850000, 1_200_000, 2100, 650]);
  });
});

describe("Elena review", () => {
  it("clears a consistent listing with no findings", () => {
    const r = reviewListing(good());
    expect(r).toMatchObject({ ready: true, blockers: 0, advice: 0 });
  });
  it("blocks missing required fields and an empty gallery", () => {
    const r = reviewListing(good({ photos: { photos: [], floorplans: 0 } }, { suburb: undefined, postcode: undefined, bedrooms: undefined, description: undefined }));
    expect(r.ready).toBe(false);
    expect(r.findings.filter(f => f.severity === "block").map(f => f.id)).toEqual(expect.arrayContaining(["suburb", "postcode", "bedrooms", "description", "photos-none"]));
  });
  it("blocks when the description disagrees with the form", () => {
    const got = ids(good({}, { description: "A lovely 3 bedroom home with 1 bathroom and 1 car space. Asking $780,000, close to everything and the shops." }));
    expect(got).toEqual(expect.arrayContaining(["bedrooms-mismatch", "bathrooms-mismatch", "parking-mismatch", "price-mismatch"]));
  });
  it("ignores dollar figures far from the price (rates, strata)", () => {
    expect(ids(good({}, { description: "A renovated 4 bedroom home with 2 bathrooms, 2 car spaces and a pool. Council rates $2,100 a year. Close to cafes." }))).not.toContain("price-mismatch");
  });
  it("catches a denied feature that is ticked, and a stated feature that is not ticked", () => {
    expect(ids(good({}, { description: "A renovated 4 bedroom home with 2 bathrooms and 2 car spaces. There is no pool but a big yard near the train." }))).toContain("feature-pool");
    const f = reviewListing(good({}, { amenities: [] })).findings.find(x => x.id === "feature-pool");
    expect(f?.severity).toBe("advice");
  });
  it("advises on photos that do not match the description when photos are filed under rooms", () => {
    const i = good({ photos: { photos: [1, 2, 3, 4, 5].map(() => photo({ category: "living" })), floorplans: 1 } });
    expect(ids(i)).toEqual(expect.arrayContaining(["photo-pool", "photo-bedroom"]));
  });
  it("requires a site plan for land and only suggests one otherwise", () => {
    const none = { photos: { photos: [photo(), photo(), photo(), photo(), photo()], floorplans: 0 } };
    expect(reviewListing(good(none, { propertyType: "land", bedrooms: undefined, bathrooms: undefined })).findings.find(f => f.id === "siteplan")?.severity).toBe("block");
    expect(reviewListing(good(none)).findings.find(f => f.id === "siteplan")?.severity).toBe("advice");
  });
  it("blocks uncleared discriminatory wording and lets a staff clearance through", () => {
    const text = "No children please. A renovated 4 bedroom home with 2 bathrooms, 2 car spaces and a pool near the train.";
    const flags = scanFields({ description: text });
    expect(flags.length).toBeGreaterThan(0);
    const blocked = reviewListing(good({ wordingFlags: flags }, { description: text }));
    expect(blocked.findings.some(f => f.area === "wording" && f.severity === "block")).toBe(true);
    const clear = new Set(flags.flatMap(f => f.flags.map(x => `${f.field}:${x.match.toLowerCase()}`)));
    expect(reviewListing(good({ wordingFlags: flags, clearedWording: clear }, { description: text })).findings.some(f => f.area === "wording" && f.severity === "block")).toBe(false);
  });
  it("turns gate reasons into compliance findings with a link to fix them", () => {
    const r = reviewListing(good({ gateReasons: ["Required disclosure missing: vendor statement.", "The listing fee or plan has not been paid."] }));
    expect(r.ready).toBe(false);
    expect(r.findings.map(f => f.fixHref)).toEqual(expect.arrayContaining(["/listings/l1/disclosures", "/listings/l1/checkout"]));
  });
  it("lists blockers before advice", () => {
    const r = reviewListing(good({ photos: { photos: [photo()], floorplans: 0 } }, { postcode: undefined }));
    expect(r.findings[0]!.severity).toBe("block");
  });
});

describe("publishListing with Elena wired", () => {
  const owner: Actor = { userId: "owner-1", userType: "owner" };
  let n = 0;
  const make = (facts: ElenaInput["photos"] | Error, queued: string[]): ListingServiceDeps => ({
    repo: createInMemoryListingRepository(), appendAudit: async () => {}, now: () => "2026-11-06T00:00:00.000Z", newId: () => `id-${++n}`,
    requiredDisclosures: () => [], trustAccountFor: async () => ({ kind: "approved" as const, reasons: [] }),
    elenaFacts: async () => { if (facts instanceof Error) throw facts; return facts; },
    queueForModeration: async l => { queued.push(l.id); }
  });
  const seed = async (deps: ListingServiceDeps) => {
    const l = await createDraft(deps, owner, {
      title: "Renovated family home", address: "1 Example St", jurisdiction: "QLD", transactionType: "sale", useClass: "residential", propertyType: "house",
      priceCents: 85_000_000, suburb: "Paddington", postcode: "4064", bedrooms: 4, bathrooms: 2, parking: 2, amenities: ["pool"],
      description: "A renovated 4 bedroom home with 2 bathrooms, 2 car spaces and a pool, close to cafes and the train."
    });
    const rec = (await deps.repo.get(l.id))!;
    await deps.repo.save({ ...rec, listingFeePaid: true, termsAccepted: true });
    return l.id;
  };
  const photos = { photos: [1, 2, 3, 4, 5].map(() => photo()), floorplans: 1 };

  it("publishes and queues for staff when Elena clears it", async () => {
    const queued: string[] = [];
    const deps = make(photos, queued);
    const id = await seed(deps);
    const r = await publishListing(deps, owner, id, false);
    expect(r.ok && r.value.listing.status).toBe("published");
    expect(r.ok && r.value.elena?.ready).toBe(true);
    expect(queued).toEqual([id]);
  });
  it("does not publish or queue a listing with no photos, and says why", async () => {
    const queued: string[] = [];
    const deps = make({ photos: [], floorplans: 0 }, queued);
    const id = await seed(deps);
    const r = await publishListing(deps, owner, id, false);
    expect(r.ok && r.value.decision.allowed).toBe(false);
    expect(r.ok && r.value.listing.status).toBe("draft");
    expect(r.ok && r.value.elena?.findings.map(f => f.id)).toContain("photos-none");
    expect(queued).toEqual([]);
  });
  it("fails closed when the gallery cannot be read", async () => {
    const deps = make(new Error("db down"), []);
    const id = await seed(deps);
    const r = await publishListing(deps, owner, id, false);
    expect(r.ok && r.value.decision.allowed).toBe(false);
    expect(r.ok && r.value.listing.status).toBe("draft");
  });
  it("a dry run reports the review and changes nothing", async () => {
    const queued: string[] = [];
    const deps = make(photos, queued);
    const id = await seed(deps);
    const r = await publishListing(deps, owner, id, true);
    expect(r.ok && r.value.elena?.ready).toBe(true);
    expect((await deps.repo.get(id))!.listing.status).toBe("draft");
    expect(queued).toEqual([]);
  });
});
