import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAnalytics } from "../src/server/admin-analytics-db";
import { loadReport } from "../src/server/admin-report-builder-db";
import type { Queryable } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("admin analytics and report builder (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let agentId: string;
  // Brisbane is UTC+10 all year: 2026-10-05T15:00Z is 6 Oct 01:00 local, so it buckets on the 6th, not the 5th.
  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    agentId = await addUser(db, "agent");
    await db.query(`UPDATE app_user SET display_name = 'Jane Citizen', created_at = '2026-10-07T00:00:00Z' WHERE id = $1`, [agentId]);
    await db.query(`UPDATE app_user SET created_at = '2026-10-06T00:00:00Z' WHERE id IN ($1, $2)`, [owner, buyer]);
    const house = await addListing(db, owner, { status: "published", property_type: "house", jurisdiction: "QLD", suburb: " paddington ", created_at: "2026-10-05T15:00:00Z" });
    const unit = await addListing(db, owner, { status: "draft", property_type: "unit", jurisdiction: "QLD", suburb: "Paddington", created_at: "2026-10-12T00:00:00Z" });
    await addListing(db, owner, { status: "published", property_type: "house", jurisdiction: "NSW", created_at: "2026-08-01T00:00:00Z" });
    await db.query(`INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1, $2, $3, 'full')`, [unit, agentId, owner]);
    await db.query(`INSERT INTO audit_event (actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, occurred_at)
                    VALUES ('user', $1, 'listing', $2, 'listing.published', $3, '2026-10-06T02:00:00Z')`, [owner, house, randomUUID()]);
    for (const [status, at] of [["accepted", "2026-10-13T00:00:00Z"], ["rejected", "2026-10-13T00:00:00Z"], ["submitted", "2026-09-01T00:00:00Z"]]) {
      const link = (await db.query(`INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at)
        VALUES (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1, $2, now() + interval '1 day', now()) RETURNING token_hash`, [house, buyer])).rows[0]!["token_hash"];
      await db.query(`INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
        VALUES ($1, $2, 100, 30, 10, true, $3, $4, $5)`, [house, buyer, link, status, at]);
    }
    await db.query(`INSERT INTO invoice (owner_user_id, listing_id, amount_ex_gst_cents, gst_cents, total_cents, status, provider, paid_at)
                    VALUES ($1, $2, 1000, 100, 1100, 'paid', 'payway', '2026-10-14T00:00:00Z')`, [owner, house]);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("buckets by day in Brisbane time", async () => {
    const rows = await loadAnalytics(db, { from: "2026-10-05", to: "2026-10-14", bucket: "day" });
    const get = (m: string) => rows.filter(r => r.metric === m).map(r => [r.bucket, r.value]).sort();
    expect(get("listings_created")).toEqual([["2026-10-06", 1], ["2026-10-12", 1]]);
    expect(get("listings_published")).toEqual([["2026-10-06", 1]]);
    expect(get("offers_submitted")).toEqual([["2026-10-13", 2]]);
    expect(get("offers_accepted")).toEqual([["2026-10-13", 1]]);
    expect(get("revenue_cents")).toEqual([["2026-10-14", 1100]]);
    expect(get("signups_agent")).toEqual([["2026-10-07", 1]]);
  });

  it("buckets by Monday-start week and leaves out earlier data", async () => {
    const rows = await loadAnalytics(db, { from: "2026-10-01", to: "2026-10-25", bucket: "week" });
    expect(rows.filter(r => r.metric === "listings_created").map(r => [r.bucket, r.value]).sort()).toEqual([["2026-10-05", 1], ["2026-10-12", 1]]);
    expect(rows.filter(r => r.metric === "offers_submitted").reduce((s, r) => s + r.value, 0)).toBe(2);
  });

  it("groups the report by property type, suburb and agent", async () => {
    const range = { from: "2026-10-01", to: "2026-10-25", bucket: "month" as const };
    const byType = await loadReport(db, { range, dimension: "category" });
    expect(byType.find(r => r.key === "house")).toMatchObject({ listingsCreated: 1, liveNow: 2, offers: 2, accepted: 1, revenueCents: 1100 });
    expect(byType.find(r => r.key === "unit")).toMatchObject({ listingsCreated: 1, liveNow: 0, offers: 0 });
    const bySuburb = await loadReport(db, { range, dimension: "suburb" });
    expect(bySuburb.find(r => r.key === "Paddington")?.listingsCreated).toBe(2);
    const byAgent = await loadReport(db, { range, dimension: "agent" });
    expect(byAgent.find(r => r.key === agentId)).toMatchObject({ agentName: "Jane Citizen", listingsCreated: 1 });
    expect(byAgent.find(r => r.key === "none")).toMatchObject({ agentName: null, listingsCreated: 1, offers: 2 });
  });
});
