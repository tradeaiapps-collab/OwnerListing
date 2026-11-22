import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSuburbPg, importSuburbsPg, listSuburbsPg } from "../src/server/suburb-data-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("suburb data (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });
  const NOW = "2026-11-18T01:00:00.000Z";

  it("imports, matches suburbs case-insensitively, replaces on re-import and lists", async () => {
    const u = await addUser(db, "admin");
    const a = await importSuburbsPg(db, [
      { state: "NSW", suburb: "Bondi", postcode: "2026", metrics: { medianHousePrice: 345000000, population: 11400 } },
      { state: "VIC", suburb: "St Kilda", postcode: "3182", metrics: { medianWeeklyRent: 65000 } }
    ], { source: "ABS Census 2021", asAt: "2021-08-10", userId: u, now: NOW, importId: randomUUID() });
    expect(a).toEqual({ created: 2, updated: 0 });
    expect(await getSuburbPg(db, "VIC", "st  KILDA")).toMatchObject({ suburb: "St Kilda", postcode: "3182", metrics: { medianWeeklyRent: 65000 }, source: "ABS Census 2021", asAt: "2021-08-10" });
    expect(await getSuburbPg(db, "NSW", "St Kilda")).toBeNull();
    const b = await importSuburbsPg(db, [{ state: "NSW", suburb: "bondi", postcode: null, metrics: { population: 12000 } }], { source: "Vendor X", asAt: "2026-06-30", userId: u, now: NOW, importId: randomUUID() });
    expect(b).toEqual({ created: 0, updated: 1 });
    expect(await getSuburbPg(db, "NSW", "Bondi")).toMatchObject({ suburb: "bondi", postcode: null, metrics: { population: 12000 }, source: "Vendor X" });
    expect((await listSuburbsPg(db, "kild")).rows.map(r => r.suburb)).toEqual(["St Kilda"]);
    expect((await listSuburbsPg(db, "")).total).toBe(2);
    expect((await listSuburbsPg(db, "100%")).total).toBe(0);
  });

  it("a failing row rolls back the whole import", async () => {
    const u = await addUser(db, "admin");
    await expect(importSuburbsPg(db, [
      { state: "QLD", suburb: "Paddington", postcode: "4064", metrics: { population: 1 } },
      { state: "QLD", suburb: "Bad", postcode: "12", metrics: { population: 1 } }
    ], { source: "ABS", asAt: "2021-08-10", userId: u, now: NOW, importId: randomUUID() })).rejects.toThrow();
    expect(await getSuburbPg(db, "QLD", "Paddington")).toBeNull();
  });
});
