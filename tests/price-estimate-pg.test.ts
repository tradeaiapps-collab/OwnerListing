import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertPriceEstimatePg, latestPriceEstimatePg } from "../src/server/price-guidance";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("price_estimate on Postgres", () => {
  let t: TestDb;
  let listing: string;
  beforeAll(async () => {
    t = await createTestDb();
    listing = await addListing(t.db, await addUser(t.db, "owner"));
  }, 60_000);
  afterAll(async () => { await t?.close(); });
  const est = (mid: number) => ({ lowCents: mid - 5_000_000, midCents: mid, highCents: mid + 5_000_000, confidence: 0.62, comparables: [], modelVersion: "comparables-v1", basis: [] });

  it("stores estimates insert-only and returns the newest", async () => {
    expect(await latestPriceEstimatePg(t.db, listing)).toBeUndefined();
    await insertPriceEstimatePg(t.db, randomUUID(), listing, est(100_000_000), "file", "2026-10-24T00:00:00.000Z");
    await insertPriceEstimatePg(t.db, randomUUID(), listing, est(110_000_000), "file", "2026-10-25T00:00:00.000Z");
    expect(await latestPriceEstimatePg(t.db, listing)).toMatchObject({ midCents: 110_000_000, confidence: 0.62, source: "file", createdAt: "2026-10-25T00:00:00.000Z" });
    await expect(t.db.query("UPDATE price_estimate SET mid_cents = 1")).rejects.toThrow();
    await expect(t.db.query("DELETE FROM price_estimate")).rejects.toThrow();
  });
  it("refuses an inverted range", async () => {
    await expect(insertPriceEstimatePg(t.db, randomUUID(), listing, { ...est(100_000_000), lowCents: 120_000_000 }, "file", new Date().toISOString())).rejects.toThrow();
  });
});
