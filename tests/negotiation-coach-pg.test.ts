import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestOwnerCounterCentsPg, resetModelCache, trainingSamplesPg, currentModelPg } from "../src/server/negotiation-coach-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("negotiation coach queries on Postgres", () => {
  let t: TestDb;
  let owner: string, b1: string, b2: string, sale: string, rent: string;
  const addOffer = async (l: string, buyer: string, price: number, status: string, at: string, o: { deposit?: number; days?: number; conditions?: string[] } = {}) => {
    const hash = randomBytes(32).toString("hex");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at, used_at) VALUES ($1,$2,$3, now() + interval '1 day', now())", [hash, l, buyer]);
    const r = await t.db.query(
      `INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,true,$7,$8,$9) RETURNING id`, [l, buyer, price, JSON.stringify(o.conditions ?? []), o.days ?? 30, o.deposit ?? 0, hash, status, at]);
    return String(r.rows[0]!["id"]);
  };
  beforeAll(async () => {
    t = await createTestDb();
    owner = await addUser(t.db, "owner"); b1 = await addUser(t.db, "buyer"); b2 = await addUser(t.db, "buyer");
    sale = await addListing(t.db, owner, { status: "published", price_cents: 90_000_000 });
    rent = await addListing(t.db, owner, { status: "published", transaction_type: "rent", price_cents: 90_000 });
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("returns closed and failed sale offers as numbers only: no ids, no open offers, no rentals", async () => {
    const first = await addOffer(sale, b1, 70_000_000, "rejected", "2026-10-20T00:00:00Z", { conditions: ["Subject to finance"] });
    const second = await addOffer(sale, b1, 88_000_000, "accepted", "2026-10-22T00:00:00Z", { deposit: 8_800_000 });
    await addOffer(sale, b2, 85_000_000, "submitted", "2026-10-21T00:00:00Z");
    await addOffer(rent, b2, 80_000, "accepted", "2026-10-21T00:00:00Z");
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, price_cents, settlement_days) VALUES ($1,'owner_countered','owner',$2,30)", [second, 89_000_000]);
    const rows = await trainingSamplesPg(t.db);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.y).sort()).toEqual([0, 1]);
    const win = rows.find(r => r.y === 1)!;
    expect(win.x).toHaveLength(10);
    expect(win.x[9]).toBe(1); // this buyer raised before
    expect(win.x[8]).toBeCloseTo(2 / 3); // two other offers on the listing within 30 days, so three in play
    expect(JSON.stringify(rows)).not.toContain(b1);
    expect(JSON.stringify(rows)).not.toContain(second);
    void first;
  });
  it("finds the latest owner counter on an offer", async () => {
    const o = await addOffer(sale, b2, 84_000_000, "countered", "2026-10-23T00:00:00Z");
    expect(await latestOwnerCounterCentsPg(t.db, o)).toBeUndefined();
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, price_cents, settlement_days, occurred_at) VALUES ($1,'owner_countered','owner',$2,30,'2026-10-24T00:00:00Z')", [o, 89_000_000]);
    await t.db.query("INSERT INTO offer_event (offer_id, event_type, actor_kind, price_cents, settlement_days, occurred_at) VALUES ($1,'owner_countered','owner',$2,30,'2026-10-25T00:00:00Z')", [o, 87_500_000]);
    expect(await latestOwnerCounterCentsPg(t.db, o)).toBe(87_500_000);
  });
  it("falls back to the starting weights with so little history, and caches the model", async () => {
    resetModelCache();
    const m = await currentModelPg(t.db, 1000);
    expect(m.source).toBe("prior");
    expect(await currentModelPg(t.db, 2000)).toBe(m);
    resetModelCache();
  });
});
