import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOverview } from "../src/server/admin-dashboard-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("admin dashboard figures (Postgres)", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("counts the current and previous windows separately", async () => {
    const db = t.db;
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    await addUser(db, "buyer", "suspended");
    await addUser(db, "admin");
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const live = await addListing(db, owner, { status: "published", created_at: day(5) });
    await addListing(db, owner, { status: "draft", created_at: day(40) });
    for (const [status, at] of [["accepted", day(2)], ["rejected", day(2)], ["submitted", day(45)]] as const) {
      const link = (await db.query(
        `INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at)
         VALUES (encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1, $2, now() + interval '1 day', now()) RETURNING token_hash`, [live, buyer])).rows[0]!["token_hash"];
      await db.query(
        `INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
         VALUES ($1, $2, 100, 30, 10, true, $3, $4, $5)`, [live, buyer, link, status, at]);
    }
    await db.query(`INSERT INTO invoice (owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, provider, paid_at) VALUES ($1,1000,100,1100,'paid','payway',$2), ($1,500,50,550,'paid','payway',$3), ($1,500,50,550,'pending','payway',NULL)`,
      [owner, day(1), day(35)]);

    const o = await loadOverview(db, 30);
    expect(o.listingsByStatus).toEqual([{ key: "draft", count: 1 }, { key: "published", count: 1 }]);
    expect(o.newListings).toEqual({ current: 1, previous: 1 });
    expect(o.offersSubmitted).toEqual({ current: 2, previous: 1 });
    expect(o.offersAccepted).toEqual({ current: 1, previous: 0 });
    expect(o.revenueCents).toEqual({ current: 1100, previous: 550 });
    expect(o.suspendedUsers).toBe(1);
    expect(o.newUsers.current).toBe(3); // the admin account is not a user
    expect(o.usersByType.find(u => u.key === "buyer")?.count).toBe(2);
  });
});
