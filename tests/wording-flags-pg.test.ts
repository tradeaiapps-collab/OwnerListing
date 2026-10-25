import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanFields } from "../src/domain/discrimination-filter";
import { createPgListingRepository } from "../src/server/db";
import { clearedWordingFlagsPg, listWordingFlagsPg, recordWordingFlagsPg, reviewWordingFlagPg } from "../src/server/wording-flags-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("wording flags (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const setup = async () => {
    const owner = await addUser(db, "owner");
    const staff = await addUser(db, "admin");
    const listingId = await addListing(db, owner, { title: "Over 55s only", jurisdiction: "QLD" });
    await db.query("UPDATE property_listing SET description = $2 WHERE id = $1", [listingId, "Quiet complex. No kids. Perfect for families."]);
    const fields = scanFields({ title: "Over 55s only", description: "Quiet complex. No kids. Perfect for families." });
    return { owner, staff, listingId, fields };
  };

  it("stores and reads the listing description", async () => {
    const { listingId } = await setup();
    const rec = await createPgListingRepository(db).get(listingId);
    expect(rec?.listing.description).toBe("Quiet complex. No kids. Perfect for families.");
    await expect(db.query("UPDATE property_listing SET description = '' WHERE id = $1", [listingId])).rejects.toThrow(/check/);
  });

  it("records only blocking flags, once per match, counting attempts", async () => {
    const { owner, listingId, fields } = await setup();
    await recordWordingFlagsPg(db, listingId, owner, fields);
    await recordWordingFlagsPg(db, listingId, owner, fields);
    const open = (await listWordingFlagsPg(db, "open")).filter(f => f.listingId === listingId);
    expect(open.map(f => [f.field, f.matchText, f.category, f.attempts]).sort()).toEqual([
      ["description", "No kids", "familial_status", 2], ["title", "Over 55s only", "age", 2]
    ]);
    expect(open[0]!.context.length).toBeGreaterThan(0);
  });

  it("clears with a reason; the owner cannot review their own flag; a reviewed flag cannot be reviewed again", async () => {
    const { owner, staff, listingId, fields } = await setup();
    await recordWordingFlagsPg(db, listingId, owner, fields);
    const title = (await listWordingFlagsPg(db, "open")).find(f => f.listingId === listingId && f.field === "title")!;
    expect((await reviewWordingFlagPg(db, title.id, owner, "clear", "My own listing is fine.")).outcome).toBe("own_flag");
    expect(await reviewWordingFlagPg(db, title.id, staff, "clear", "Registered over-55s community.")).toEqual({ outcome: "reviewed", listingId });
    expect((await reviewWordingFlagPg(db, title.id, staff, "uphold", "Changed my mind on it.")).outcome).toBe("already_reviewed");
    expect([...(await clearedWordingFlagsPg(db, listingId))]).toEqual(["title:over 55s only"]);
    // Another attempt keeps the decision.
    await recordWordingFlagsPg(db, listingId, owner, fields);
    expect((await listWordingFlagsPg(db, "cleared")).find(f => f.id === title.id)?.status).toBe("cleared");
    expect((await reviewWordingFlagPg(db, "not-a-uuid", staff, "clear", "Whatever reason here.")).outcome).toBe("not_found");
  });

  it("keeps rows permanently and enforces the review fields", async () => {
    const { owner, listingId, fields } = await setup();
    await recordWordingFlagsPg(db, listingId, owner, fields);
    await expect(db.query("DELETE FROM wording_flag WHERE listing_id = $1", [listingId])).rejects.toThrow(/permanent/);
    await expect(db.query("UPDATE wording_flag SET status = 'cleared' WHERE listing_id = $1", [listingId])).rejects.toThrow(/check/);
  });

  it("accepts the discrimination_flag admin case kind", async () => {
    const { listingId } = await setup();
    await db.query("INSERT INTO admin_case (kind, subject_id, reason) VALUES ('discrimination_flag', $1, 'Buyer reported discrimination')", [listingId]);
  });
});
