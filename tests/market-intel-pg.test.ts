import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadDemandFacts, runMarketShiftAlerts } from "../src/server/market-intel-db";
import type { Queryable } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
const NOW = "2026-11-05T00:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

describe.skipIf(!DATABASE_URL)("market intelligence queries and shift alerts (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let agentId: string, otherAgent: string, listing: string, otherListing: string;
  const subject = { transactionType: "sale" as const, propertyType: "house", suburb: "Paddington", postcode: "4064" };

  async function sold(daysBack: number, cents: number) {
    const p = await db.query(
      "INSERT INTO property (address_text, state, suburb, postcode, property_type, bedrooms, bathrooms, car_spaces, land_area_sqm) VALUES ($1,'QLD','Paddington','4064','house',3,2,1,450) RETURNING id",
      [`${randomUUID()} Test St`]);
    await db.query("INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source) VALUES ($1::uuid,'sold',$2::timestamptz,$3,'platform')", [p.rows[0]!["id"], daysAgo(daysBack), cents]);
  }

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const owner = await addUser(db, "owner");
    agentId = await addUser(db, "agent");
    otherAgent = await addUser(db, "agent");
    listing = await addListing(db, owner, { status: "published", jurisdiction: "QLD", suburb: " Paddington ", postcode: "4064" });
    otherListing = await addListing(db, owner, { status: "published", jurisdiction: "NSW", suburb: "Elsewhere", postcode: "9999" });
    await db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1,$2,$3,'full')", [listing, agentId, owner]);
    await db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1,$2,$3,'full')", [otherListing, otherAgent, owner]);
    // Prices climbing hard: 12 sales over the last year, about 10% apart between the older and newer half.
    for (let i = 0; i < 6; i++) await sold(20 + i * 25, 150_000_000 + i * 500_000); // last ~5 months, high
    for (let i = 0; i < 6; i++) await sold(200 + i * 25, 120_000_000 + i * 500_000); // 7 to 11 months ago, lower
    // Buyer activity on the listing: saves and enquiries in recent weeks.
    for (let i = 0; i < 6; i++) {
      const buyer = await addUser(db, "buyer");
      await db.query("INSERT INTO saved_listing (buyer_user_id, listing_id, created_at) VALUES ($1,$2,$3)", [buyer, listing, daysAgo(3 + i)]);
      if (i < 3) await db.query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2,$3)", [listing, buyer, daysAgo(5 + i)]);
    }
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("loads weekly buyer activity for the suburb (trimmed, any case) and counts published listings", async () => {
    const f = (await loadDemandFacts(db, { ...subject, suburb: "paddington", postcode: "9999" }, NOW))!;
    expect(f.weeks).toHaveLength(8);
    expect(f.activeListings).toBe(2); // matched by suburb or by postcode
    const saves = f.weeks.reduce((s, w) => s + w.saves, 0), enquiries = f.weeks.reduce((s, w) => s + w.enquiries, 0);
    expect(saves).toBe(6);
    expect(enquiries).toBe(3);
    expect(f.weeks[7]!.saves).toBeGreaterThan(0); // newest week last
    expect((await loadDemandFacts(db, { transactionType: "sale", propertyType: "house" }, NOW))).toBeUndefined();
    expect((await loadDemandFacts(db, { ...subject, transactionType: "rent" }, NOW))!.activeListings).toBe(0);
  });

  it("alerts the agent of the area once per shift per month, and not the agent of another area", async () => {
    const first = await runMarketShiftAlerts(db, NOW, {});
    expect(first.areas).toBe(2);
    expect(first.shifts).toBeGreaterThan(0);
    const mine = (await db.query("SELECT kind, title FROM notification WHERE user_id = $1 AND kind = 'market_shift'", [agentId])).rows;
    expect(mine.length).toBeGreaterThan(0);
    expect(String(mine[0]!["title"])).toMatch(/prices up/i);
    expect((await db.query("SELECT 1 FROM notification WHERE user_id = $1", [otherAgent])).rows).toHaveLength(0);
    const rows = (await db.query("SELECT count(*)::int AS n FROM market_shift_alert WHERE agent_user_id = $1", [agentId])).rows[0]!["n"];
    expect(rows).toBe(mine.length);

    const again = await runMarketShiftAlerts(db, NOW, {});
    expect(again.notified).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'market_shift'", [agentId])).rows[0]!["n"]).toBe(mine.length);
  });

  it("does not alert a revoked appointment", async () => {
    await db.query("UPDATE listing_agent_appointment SET revoked_at = now() WHERE agent_user_id = $1", [agentId]);
    await db.query("DELETE FROM market_shift_alert");
    await db.query("DELETE FROM notification WHERE user_id = $1", [agentId]);
    const r = await runMarketShiftAlerts(db, NOW, {});
    expect(r.notified).toBe(0);
    expect((await db.query("SELECT 1 FROM notification WHERE user_id = $1", [agentId])).rows).toHaveLength(0);
  });
});
