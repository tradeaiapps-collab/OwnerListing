import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReport, buildStaffReport, ensureFreshSnapshots, loadListingFacts, loadPoints, refreshListingSnapshots } from "../src/server/listing-performance-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
const NOW = "2026-11-05T12:00:00.000Z";
const ago = (d: number, h = 0) => new Date(Date.parse(NOW) - d * 86_400_000 - h * 3_600_000).toISOString();

describe.skipIf(!DATABASE_URL)("listing performance (Postgres)", () => {
  let t: TestDb;
  let owner: string, listing: string;
  const db = () => t.db;
  const one = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows[0]!;
  const view = (l: string, buyer: string, at: string) => db().query("INSERT INTO listing_view (listing_id, viewer_user_id, viewed_at) VALUES ($1,$2,$3)", [l, buyer, at]);
  const offer = async (l: string, buyer: string, at: string, status = "submitted") => {
    const hash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await db().query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,$4)", [hash, l, buyer, ago(-30)]);
    const r = await db().query(
      "INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, settlement_days, deposit_cents, confirmed_final, link_token_hash, status, submitted_at) VALUES ($1,$2,95000000,42,5000000,true,$3,$4,$5) RETURNING id",
      [l, buyer, hash, status, at]);
    return String(r.rows[0]!["id"]);
  };

  beforeAll(async () => {
    t = await createTestDb();
    owner = await addUser(db(), "owner");
    listing = await addListing(db(), owner, { status: "published", jurisdiction: "QLD", suburb: "Paddington", postcode: "4064", price_cents: 110_000_000, bedrooms: 3, created_at: ago(20) });
    const buyers = await Promise.all([1, 2, 3, 4].map(() => addUser(db(), "buyer")));
    // Today: 3 views. 3 days ago: 2 views and an enquiry. 5 days ago: the first offer.
    for (const b of buyers.slice(0, 3)) await view(listing, b, ago(0, 1));
    for (const b of buyers.slice(0, 2)) await view(listing, b, ago(3));
    await db().query("INSERT INTO enquiry (listing_id, buyer_user_id, created_at) VALUES ($1,$2,$3)", [listing, buyers[0], ago(3)]);
    await offer(listing, buyers[1]!, ago(5));
    // Four similar listings with their own activity.
    for (let i = 0; i < 4; i++) {
      const o = await addUser(db(), "owner");
      const l = await addListing(db(), o, { status: "published", jurisdiction: "QLD", suburb: "Paddington", postcode: "4064", price_cents: 105_000_000 + i * 2_000_000, created_at: ago(40) });
      for (let v = 0; v < 6 + i; v++) await view(l, buyers[v % 4]!, ago(1, v));
      await offer(l, buyers[0]!, ago(25 - i));
    }
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("builds daily rows from the raw records and is safe to repeat", async () => {
    await refreshListingSnapshots(db(), listing, NOW);
    await refreshListingSnapshots(db(), listing, NOW);
    const pts = await loadPoints(db(), listing, NOW);
    expect(pts.length).toBeGreaterThanOrEqual(20);
    const by = new Map(pts.map(p => [p.date, p]));
    expect(by.get("2026-11-05")).toMatchObject({ views: 3, inquiries: 0, offers: 0 });
    expect(by.get("2026-11-02")).toMatchObject({ views: 2, inquiries: 1 });
    expect(by.get("2026-10-31")).toMatchObject({ offers: 1 });
    expect((await one("SELECT count(*)::int AS n FROM listing_performance_daily_snapshot WHERE listing_id = $1", [listing]))["n"]).toBe(pts.length);
    expect((await one("SELECT time_to_offer_days FROM listing_performance_daily_snapshot WHERE listing_id = $1 AND offers = 1", [listing]))["time_to_offer_days"]).toBe(15);
  });

  it("only rebuilds when the snapshots are old", async () => {
    expect(await ensureFreshSnapshots(db(), listing, NOW)).toBe(false);
    expect(await ensureFreshSnapshots(db(), listing, new Date(Date.parse(NOW) + 3_600_000).toISOString())).toBe(true);
  });

  it("reports windows, a market comparison from similar listings, a heatmap and advice, and caches the market for a day", async () => {
    const facts = (await loadListingFacts(db(), listing))!;
    const r = await buildReport(db(), facts, NOW);
    expect(r.windows.find(w => w.days === 30)!.views).toBe(5);
    expect(r.windows.find(w => w.days === 30)!.offers).toBe(1);
    expect(r.market.state).toBe("ready");
    if (r.market.state === "ready") { expect(r.market.count).toBe(4); expect(JSON.stringify(r.market)).not.toContain("Home"); }
    expect(r.advice.prediction.state).toBe("has_offer");
    expect(r.daily).toHaveLength(90);
    expect((await one("SELECT count(*)::int AS n FROM listing_performance_cache WHERE listing_id = $1", [listing]))["n"]).toBe(1);
    const again = await buildReport(db(), facts, NOW);
    expect(again.market).toEqual(r.market);
  });

  it("records the outcome once an offer is accepted", async () => {
    const buyer = await addUser(db(), "buyer");
    const l = await addListing(db(), owner, { status: "published", jurisdiction: "QLD", suburb: "Toowong", postcode: "4066", created_at: ago(30) });
    const id = await offer(l, buyer, ago(10), "accepted");
    await db().query("INSERT INTO offer_event (offer_id, event_type, actor_kind, occurred_at) VALUES ($1,'accepted','owner',$2)", [id, ago(8)]);
    await refreshListingSnapshots(db(), l, NOW);
    expect(await one("SELECT days_to_first_offer, days_to_acceptance, total_offers FROM listing_performance_outcome WHERE listing_id = $1", [l]))
      .toMatchObject({ days_to_first_offer: 20, days_to_acceptance: 22, total_offers: 1 });
  });

  it("staff report totals the live listings and returns median days from outcomes", async () => {
    const s = await buildStaffReport(db(), NOW);
    expect(s.listings).toBeGreaterThanOrEqual(6);
    expect(s.totals30.views).toBeGreaterThan(0);
    expect(s.medianDaysToFirstOffer).toBe(20);
    expect(s.medianDaysToAcceptance).toBe(22);
    expect(s.daily).toHaveLength(90);
  });
});
