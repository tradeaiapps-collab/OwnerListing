import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAddressRatesPg, importAddressRatesPg } from "../src/server/address-rates-db";
import { getRatesPg, saveRatesPg } from "../src/server/listing-rates-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("address rates (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });
  const NOW = "2026-11-21T01:00:00.000Z";

  it("imports, finds by a differently written address, and replaces on a second import", async () => {
    const u = await addUser(db, "admin");
    const rows = [{ state: "NSW" as const, address: "12 Smith St Bondi", rates: { council: { cents: 52040, period: "quarter" as const } } }];
    expect(await importAddressRatesPg(db, rows, { source: "Test export", asAt: "2026-07-01", userId: u, now: NOW })).toEqual({ created: 1, updated: 0 });
    const hit = await findAddressRatesPg(db, "NSW", "12 Smith Street, Bondi NSW 2026");
    expect(hit).toMatchObject({ source: "Test export", asAt: "2026-07-01", rates: { council: { cents: 52040, period: "quarter" } } });
    expect(await findAddressRatesPg(db, "VIC", "12 Smith St Bondi")).toBeNull();
    const again = [{ ...rows[0]!, rates: { water: { cents: 31000, period: "quarter" as const } } }];
    expect(await importAddressRatesPg(db, again, { source: "Newer", asAt: "2026-08-01", userId: u, now: NOW })).toEqual({ created: 0, updated: 1 });
    expect((await findAddressRatesPg(db, "NSW", "12 smith st bondi"))?.rates).toEqual({ water: { cents: 31000, period: "quarter" } });
  });

  it("stores and reads back a listing's rate source", async () => {
    const u = await addUser(db, "owner");
    const l = await addListing(db, u);
    await saveRatesPg(db, l, { council: { cents: 100000, period: "year" }, asAt: "2026-07-01", source: { kind: "staff", name: "Council notice" } }, u, NOW);
    expect((await getRatesPg(db, l))?.source).toEqual({ kind: "staff", name: "Council notice" });
    await saveRatesPg(db, l, { council: { cents: 100000, period: "year" }, asAt: "2026-07-01" }, u, NOW);
    expect((await getRatesPg(db, l))?.source).toBeUndefined();
  });
});
