import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRatesPg, saveRatesPg } from "../src/server/listing-rates-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("listing rates (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });
  const NOW = "2026-11-18T01:00:00.000Z";

  it("saves, reads back, replaces and clears a listing's rates", async () => {
    const u = await addUser(db, "owner");
    const l = await addListing(db, u);
    expect(await getRatesPg(db, l)).toBeNull();
    const rates = { council: { cents: 52040, period: "quarter" as const }, water: { cents: 120000, period: "year" as const }, waterUsageBilledSeparately: true, asAt: "2026-07-01" };
    await saveRatesPg(db, l, rates, u, NOW);
    expect(await getRatesPg(db, l)).toEqual(rates);
    await saveRatesPg(db, l, { water: { cents: 99900, period: "quarter" }, asAt: "2026-08-15" }, u, NOW);
    expect(await getRatesPg(db, l)).toEqual({ water: { cents: 99900, period: "quarter" }, asAt: "2026-08-15" });
    await saveRatesPg(db, l, {}, u, NOW);
    expect(await getRatesPg(db, l)).toBeNull();
  });

  it("database rejects a charge without a period or a notice date", async () => {
    const u = await addUser(db, "owner");
    const l = await addListing(db, u);
    await expect(db.query("INSERT INTO listing_rates (listing_id, council_cents, updated_by, updated_at) VALUES ($1, 100, $2, now())", [l])).rejects.toThrow();
    await expect(db.query("INSERT INTO listing_rates (listing_id, council_cents, council_period, updated_by, updated_at) VALUES ($1, 100, 'year', $2, now())", [l, u])).rejects.toThrow();
  });
});
