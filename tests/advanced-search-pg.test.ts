import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PropertyListing } from "../src/domain/listing";
import { parseSearchQuery, searchInMemory } from "../src/domain/listing-search";
import { createPgListingRepository } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL: the SQL search must return what the in-memory reference returns, in the same order.
describe.skipIf(!DATABASE_URL)("advanced search (Postgres)", () => {
  let t: TestDb;
  let all: PropertyListing[] = [];
  beforeAll(async () => {
    t = await createTestDb();
    const owner = await addUser(t.db, "owner");
    const base = { ownerUserId: owner, ownerUserType: "owner", jurisdiction: "QLD", status: "published", propertyType: "house", useClass: "residential",
      transactionType: "sale", disclosures: [], updatedAt: "2026-10-24T00:00:00.000Z" } as const;
    const rows: Array<Partial<PropertyListing> & { title: string; address: string }> = [
      { title: "Pool house", address: "5 Latrobe Tce Paddington", suburb: "Paddington", description: "Renovated family home with a saltwater pool", amenities: ["pool", "garage"], latitude: -27.459, longitude: 153.006, priceCents: 90_000_000 },
      { title: "City unit", address: "10 Queen St", suburb: "Brisbane City", propertyType: "unit", amenities: ["lift", "security"], latitude: -27.4698, longitude: 153.0251, priceCents: 60_000_000 },
      { title: "Beach pad", address: "2 Esplanade", suburb: "Surfers Paradise", amenities: ["pool", "balcony"], latitude: -28.0027, longitude: 153.4306, priceCents: 120_000_000 },
      { title: "No pin", address: "9 Hill Rd", suburb: "Paddington", description: "Charming cottage O'Brien's pick", amenities: ["garden"] },
      { title: "Draft pool", address: "1 Draft St", status: "draft", amenities: ["pool"] }
    ];
    const repo = createPgListingRepository(t.db);
    let i = 0;
    for (const r of rows) {
      i += 1;
      const listing = { ...base, id: crypto.randomUUID(), createdAt: `2026-10-${String(i).padStart(2, "0")}T00:00:00.000Z`, ...r } as PropertyListing;
      await repo.insert({ listing, listingFeePaid: false, termsAccepted: false });
      all.push(listing);
    }
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  const cases: Array<[string, Record<string, string>]> = [
    ["one word", { q: "pool" }],
    ["prefix", { q: "salt" }],
    ["two words in different fields", { q: "latrobe renovated" }],
    ["apostrophe text", { q: "o'brien" }],
    ["no match", { q: "zzz" }],
    ["amenity", { amenities: "pool" }],
    ["two amenities", { amenities: "pool,garage" }],
    ["text and amenity", { q: "paddington", amenities: "garden" }],
    ["radius 10 km", { lat: "-27.4698", lng: "153.0251", radiusKm: "10" }],
    ["radius 100 km nearest first", { lat: "-27.4698", lng: "153.0251", radiusKm: "100", sort: "distance" }],
    ["radius with filters", { lat: "-27.4698", lng: "153.0251", radiusKm: "100", amenities: "pool", sort: "price_asc", transactionType: "sale" }],
    ["injection text", { q: "x'); DROP TABLE property_listing; --" }]
  ];
  it.each(cases)("matches the reference: %s", async (_name, params) => {
    const query = parseSearchQuery(new URLSearchParams(params));
    const sql = await createPgListingRepository(t.db).search(query);
    const ref = searchInMemory(all, query);
    expect(sql.items.map(r => r.listing.id)).toEqual(ref.items.map(l => l.id));
    expect(sql.total).toBe(ref.total);
  });

  it("stores and returns amenities, and refuses an unknown one", async () => {
    const got = await createPgListingRepository(t.db).get(all[0]!.id);
    expect(got?.listing.amenities).toEqual(["pool", "garage"]);
    await expect(t.db.query("UPDATE property_listing SET amenities = ARRAY['moat'] WHERE id = $1", [all[0]!.id])).rejects.toThrow();
  });

  it("still table-scans safely with the text index in place", async () => {
    const r = await t.db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'property_listing' AND indexname LIKE 'property_listing_%'");
    const names = r.rows.map(x => x["indexname"]);
    expect(names).toContain("property_listing_fts_idx");
    expect(names).toContain("property_listing_amenities_idx");
  });
});
