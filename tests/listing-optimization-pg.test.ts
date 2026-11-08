import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PropertyListing } from "../src/domain/listing";
import { DEFAULT_OPTIMIZATION_SETTINGS } from "../src/domain/listing-optimization";
import type { Queryable } from "../src/server/db";
import { adoptionStats, getOptimizationSettings, listSuggestions, saveOptimizationSettings, setSuggestionStatus } from "../src/server/listing-optimization-db";
import { optimizeListing, photoFacts } from "../src/server/listing-optimization-service";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const NOW = "2026-11-05T00:00:00.000Z";
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("listing optimization (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let staff: string, owner: string, buyer: string, lid: string, other: string;
  const S = { ...DEFAULT_OPTIMIZATION_SETTINGS, enabled: true };
  const listing = (id: string, o: Partial<PropertyListing> = {}): PropertyListing => ({
    id, ownerUserId: owner, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Home", propertyType: "house", useClass: "residential", transactionType: "sale",
    address: "1 Test St", disclosures: [], createdAt: NOW, updatedAt: NOW, suburb: "Paddington", postcode: "4064", priceCents: 100_000_000, bedrooms: 3, bathrooms: 2, parking: 1, amenities: [], ...o
  });

  async function photo(listingId: string, kind: "photo" | "floorplan", width: number) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO listing_photo (id, listing_id, kind, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key) VALUES ($1,$2,$3,$4,'image/jpeg',$5,800,10,$6,$7)",
      [id, listingId, kind, owner, width, "a".repeat(64), `k/${id}`]);
    return id;
  }
  async function layout(listingId: string, entries: unknown[]) {
    await db.query("INSERT INTO listing_photo_layout (listing_id, version, entries, changed_by) VALUES ($1, 1, $2::jsonb, $3)", [listingId, JSON.stringify(entries), owner]);
  }

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    staff = await addUser(db, "admin"); owner = await addUser(db, "owner"); buyer = await addUser(db, "buyer");
    lid = await addListing(db, owner, { status: "published", jurisdiction: "QLD", suburb: "Paddington", postcode: "4064", price_cents: 100_000_000 });
    other = await addListing(db, owner, { status: "published", jurisdiction: "QLD", suburb: "Paddington", postcode: "4064" });
  });
  afterAll(async () => { await t?.close(); });

  it("starts off and keeps a single settings row", async () => {
    expect(await getOptimizationSettings(db)).toMatchObject({ enabled: false, minPhotos: 8, minDescriptionWords: 60, maxPriceCutPercent: 10, disabledTypes: [], updatedBy: null });
    await saveOptimizationSettings(db, { ...S, minPhotos: 12, disabledTypes: ["add_photos"] }, staff);
    expect(await getOptimizationSettings(db)).toMatchObject({ enabled: true, minPhotos: 12, disabledTypes: ["add_photos"], updatedBy: staff });
    expect((await db.query("SELECT count(*)::int AS n FROM listing_optimization_settings")).rows[0]!["n"]).toBe(1);
    await expect(saveOptimizationSettings(db, { ...S, minPhotos: 2 }, staff)).rejects.toThrow();
    await saveOptimizationSettings(db, S, staff);
  });

  it("reads the gallery: visible photos only, small ones, rooms, captions and floorplans", async () => {
    const a = await photo(lid, "photo", 2000), b = await photo(lid, "photo", 800), c = await photo(lid, "photo", 2000), f = await photo(lid, "floorplan", 2000);
    await layout(lid, [
      { photoId: a, caption: "Front", alt: "", hidden: false, category: "exterior" }, { photoId: b, caption: "", alt: "", hidden: false, category: "kitchen" },
      { photoId: c, caption: "Hidden one", alt: "", hidden: true, category: "living" }, { photoId: f, caption: "", alt: "", hidden: false }
    ]);
    expect(await photoFacts(db, lid)).toEqual({ visibleCount: 2, floorplans: 1, lowResCount: 1, categories: { exterior: 1, kitchen: 1 }, captioned: 1, hasTour: false });
    expect(await photoFacts(db, other)).toMatchObject({ visibleCount: 0, floorplans: 0 });
  });

  it("works out suggestions from a real listing and stores one row per type", async () => {
    const got = await optimizeListing(db, listing(lid, { description: "Short.", amenities: ["pool"] }), S, NOW);
    expect(got.map(x => x.type).sort()).toEqual(["add_photos", "expand_description", "highlight_features", "photo_gaps", "photo_resolution"].sort());
    expect(got.every(x => x.status === "open" && x.impact.viewsPercent.high >= x.impact.viewsPercent.low)).toBe(true);
    await optimizeListing(db, listing(lid, { description: "Short.", amenities: ["pool"] }), S, NOW);
    expect((await db.query("SELECT count(*)::int AS n FROM listing_optimizations WHERE listing_id = $1", [lid])).rows[0]!["n"]).toBe(5);
    await expect(db.query("INSERT INTO listing_optimizations (listing_id, suggestion_type, description, estimated_impact) VALUES ($1,'add_photos','dup','{}')", [lid])).rejects.toThrow();
  });

  it("keeps the seller's answer, marks fixed issues outdated and reopens them if they return", async () => {
    const rows = await listSuggestions(db, lid, NOW);
    const desc = rows.find(r => r.type === "expand_description")!, caps = rows.find(r => r.type === "photo_resolution")!;
    expect(await setSuggestionStatus(db, lid, desc.id, "implemented", daysAgo(20))).toBe(true);
    expect(await setSuggestionStatus(db, lid, caps.id, "dismissed", NOW)).toBe(true);
    // The seller wrote a long description (but did not really mean to keep the pool out), and the rest is unchanged.
    const long = Array.from({ length: 70 }, (_, i) => `w${i}`).join(" ");
    const after = await optimizeListing(db, listing(lid, { description: `${long} pool`, amenities: ["pool"] }), S, NOW);
    const by = new Map(after.map(r => [r.type, r]));
    expect(by.get("expand_description")!.status).toBe("implemented");
    expect(by.get("photo_resolution")!.status).toBe("dismissed");
    expect(by.get("highlight_features")!.status).toBe("outdated");
    const again = await optimizeListing(db, listing(lid, { description: long, amenities: ["pool"] }), S, NOW);
    expect(again.find(r => r.type === "highlight_features")!.status).toBe("open");
  });

  it("cannot change a suggestion through another listing, an outdated one, or with an unknown status", async () => {
    const rows = await listSuggestions(db, lid, NOW);
    const open = rows.find(r => r.status === "open")!;
    expect(await setSuggestionStatus(db, other, open.id, "implemented", NOW)).toBe(false);
    expect((await listSuggestions(db, lid, NOW)).find(r => r.id === open.id)!.status).toBe("open");
    await optimizeListing(db, listing(lid, { description: Array.from({ length: 70 }, (_, i) => `w${i}`).join(" ") }), S, NOW);
    const outdated = (await listSuggestions(db, lid, NOW)).find(r => r.status === "outdated")!;
    expect(await setSuggestionStatus(db, lid, outdated.id, "implemented", NOW)).toBe(false);
    await expect(db.query("UPDATE listing_optimizations SET status = 'bogus' WHERE id = $1", [open.id])).rejects.toThrow();
    await expect(db.query("UPDATE listing_optimizations SET status = 'implemented', implemented_at = NULL WHERE id = $1", [open.id])).rejects.toThrow();
  });

  it("reports adoption and what happened to enquiries and offers 14 days either side", async () => {
    const at = daysAgo(20);
    const enq = async (b: string, when: string) => { await db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2,$3)", [lid, b, when]); };
    const buyer2 = await addUser(db, "buyer"), buyer3 = await addUser(db, "buyer");
    await enq(buyer, daysAgo(25)); await enq(buyer2, daysAgo(18)); await enq(buyer3, daysAgo(3)); // one before, one inside the 14 days after, one outside
    const link = "f".repeat(64);
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,'2027-01-01')", [link, lid, buyer]);
    await db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, submitted_at) VALUES ($1,$2,99000000,30,1000000,true,$3,$4)", [lid, buyer, link, daysAgo(17)]);
    const rows = await listSuggestions(db, lid, NOW);
    const done = rows.find(r => r.type === "expand_description")!;
    expect(done.implementedAt).toBe(at);
    expect(done.outcome).toEqual({ days: 14, enquiriesBefore: 1, enquiriesAfter: 1, offersBefore: 0, offersAfter: 1 });
    const stats = await adoptionStats(db, NOW);
    const d = stats.find(s => s.type === "expand_description")!;
    expect(d).toMatchObject({ total: 1, implemented: 1, open: 0, dismissed: 0, adoptionPercent: 100, measured: 1, enquiriesBefore: 1, enquiriesAfter: 1, offersBefore: 0, offersAfter: 1 });
    expect(stats.find(s => s.type === "photo_resolution")).toMatchObject({ dismissed: 1, adoptionPercent: 0, measured: 0 });
    // Marked done less than 14 days ago: no outcome yet.
    expect((await listSuggestions(db, lid, daysAgo(10))).find(r => r.type === "expand_description")!.outcome).toBeNull();
  });
});
