import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAskingListings } from "../src/server/price-suggestion";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("asking listings for price suggestion on Postgres", () => {
  let t: TestDb;
  let self: string, other: string, draft: string;
  beforeAll(async () => {
    t = await createTestDb();
    const u = await addUser(t.db, "owner");
    self = await addListing(t.db, u);
    other = await addListing(t.db, u);
    draft = await addListing(t.db, u);
    for (const id of [self, other, draft]) await t.db.query("UPDATE property_listing SET suburb='Paddington', postcode='4064', price_cents=100000000, status=$2 WHERE id=$1::uuid", [id, id === draft ? "draft" : "published"]);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("returns other published listings in the suburb, never itself or drafts, with no street address", async () => {
    const rows = await loadAskingListings(t.db, self, { transactionType: "sale", propertyType: "house", suburb: "paddington" }, new Date(Date.now() + 60_000).toISOString());
    expect(rows.map(r => r.id)).toEqual([`listing:${other}`]);
    expect(rows[0]!.label).toBe("Listing in Paddington");
  });
  it("nothing without a suburb or postcode", async () => {
    expect(await loadAskingListings(t.db, self, { transactionType: "sale", propertyType: "house" }, new Date().toISOString())).toEqual([]);
  });
});
