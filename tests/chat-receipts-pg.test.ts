import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgEnquiryRepository } from "../src/server/enquiry-db";
import { listingNumberPg } from "../src/server/listing-number";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("listing number and read receipts (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("numbers every listing uniquely, starting at 10001", async () => {
    const owner = await addUser(db, "owner");
    const a = await addListing(db, owner);
    const b = await addListing(db, owner);
    const na = await listingNumberPg(db, a), nb = await listingNumberPg(db, b);
    expect(na).toBeGreaterThanOrEqual(10001);
    expect(nb).toBe(na! + 1);
    expect(await listingNumberPg(db, "00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("reports when the other side last read the thread", async () => {
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    const listing = await addListing(db, owner);
    const e = String((await db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, buyer])).rows[0]!["id"]);
    const repo = createPgEnquiryRepository(db);
    expect(await repo.lastReadByOthers(buyer, e)).toBeUndefined();
    await repo.markRead(owner, e, "2026-11-01T10:00:00.000Z");
    await repo.markRead(buyer, e, "2026-11-01T11:00:00.000Z");
    expect(await repo.lastReadByOthers(buyer, e)).toBe("2026-11-01T10:00:00.000Z");
    expect(await repo.lastReadByOthers(owner, e)).toBe("2026-11-01T11:00:00.000Z");
  });
});
