import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable } from "../src/server/db";
import { clearOverride, getOverride, getValuationSettings, listOverrides, saveValuationSettings, setOverride } from "../src/server/valuation-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("property valuation settings (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let staff: string;
  let listing: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    staff = await addUser(db, "admin");
    listing = await addListing(db, await addUser(db, "owner"), { status: "published", jurisdiction: "QLD", suburb: "Paddington", postcode: "4064" });
  });
  afterAll(async () => { await t?.close(); });

  it("starts off, with a minimum of 8 sales", async () => {
    expect(await getValuationSettings(db)).toMatchObject({ enabled: false, minComps: 8, highConfidenceComps: 12, showRange: true, updatedBy: null });
  });
  it("saves the settings with who changed them, and keeps a single row", async () => {
    await saveValuationSettings(db, { enabled: true, minComps: 10, highConfidenceComps: 15, showRange: false }, staff);
    expect(await getValuationSettings(db)).toMatchObject({ enabled: true, minComps: 10, highConfidenceComps: 15, showRange: false, updatedBy: staff });
    expect((await db.query("SELECT count(*)::int AS n FROM valuation_settings")).rows[0]!["n"]).toBe(1);
  });
  it("refuses out-of-range numbers and a high-confidence figure below the minimum", async () => {
    await expect(saveValuationSettings(db, { enabled: true, minComps: 2, highConfidenceComps: 12, showRange: true }, staff)).rejects.toThrow();
    await expect(saveValuationSettings(db, { enabled: true, minComps: 20, highConfidenceComps: 12, showRange: true }, staff)).rejects.toThrow();
  });
  it("sets, replaces, lists and clears a per-listing override", async () => {
    await setOverride(db, listing, false, "Seller disputes the sales", staff);
    expect(await getOverride(db, listing)).toMatchObject({ enabled: false, reason: "Seller disputes the sales", setBy: staff });
    await setOverride(db, listing, true, "Checked with the agent", staff);
    expect((await listOverrides(db)).map(o => [o.listingId, o.enabled])).toEqual([[listing, true]]);
    await expect(setOverride(db, listing, true, "x", staff)).rejects.toThrow();
    expect(await clearOverride(db, listing)).toBe(true);
    expect(await getOverride(db, listing)).toBeUndefined();
    expect(await clearOverride(db, listing)).toBe(false);
  });
});
