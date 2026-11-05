import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Comparable } from "../src/domain/price-guidance";
import { getPricingPreference, getSellerInsights, savePricingPreference } from "../src/server/seller-insights-db";
import { createPlatformComparablesSource } from "../src/server/property-intelligence";
import type { Queryable } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
const NOW = "2026-11-05T00:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();

describe.skipIf(!DATABASE_URL)("seller market insights (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  let listing: string;
  const subject = { transactionType: "sale" as const, propertyType: "house", suburb: "Paddington", postcode: "4064" };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    listing = await addListing(db, await addUser(db, "owner"), { status: "published", jurisdiction: "QLD", suburb: "Paddington", postcode: "4064" });
    for (let i = 0; i < 10; i++) {
      const p = await db.query(
        "INSERT INTO property (address_text, state, suburb, postcode, property_type, bedrooms, bathrooms, car_spaces, land_area_sqm) VALUES ($1,'QLD','Paddington','4064','house',3,2,1,450) RETURNING id",
        [`${randomUUID()} Test St`]);
      const pid = p.rows[0]!["id"];
      await db.query("INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source) VALUES ($1::uuid,'listed',$2::timestamptz,0,'platform')", [pid, daysAgo(10 + i * 7 + 8 + i * 3)]).catch(() => undefined);
      await db.query("INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source) VALUES ($1::uuid,'sold',$2::timestamptz,$3,'platform')", [pid, daysAgo(10 + i * 7), 100_000_000 + i * 2_000_000]);
    }
  });
  afterAll(async () => { await t?.close(); });

  it("works out insights from recorded sales and caches them, then serves the cache", async () => {
    const src = createPlatformComparablesSource(db);
    let loads = 0;
    const load = async (): Promise<Comparable[]> => { loads++; return src.find(subject, NOW); };
    const a = await getSellerInsights(db, subject, NOW, load);
    expect(a.comparables.state).toBe("ready");
    expect(loads).toBe(1);
    const rows = (await db.query("SELECT metric_type FROM market_insights_cache ORDER BY 1")).rows.map(r => r["metric_type"]);
    expect(rows).toEqual(["comparable_sales", "days_on_market", "price_days", "price_trend"]);
    const b = await getSellerInsights(db, subject, hoursAfter(NOW, 1), load);
    expect(loads).toBe(1);
    expect(b.comparables).toEqual(JSON.parse(JSON.stringify(a.comparables)));
    // Expired rows are worked out again, and a different size band never reuses another band's row.
    await getSellerInsights(db, subject, hoursAfter(NOW, 7), load);
    expect(loads).toBe(2);
    await getSellerInsights(db, { ...subject, areaSqm: 450 }, NOW, load);
    expect(loads).toBe(3);
  });

  it("keeps one pricing preference per listing and updates it", async () => {
    expect(await getPricingPreference(db, listing)).toBeUndefined();
    await savePricingPreference(db, listing, "fast_sale", { state: "ready", goal: "fast_sale", recommendedCents: 99_000_000, scenarios: [], rationale: "Because.", confidence: "fair", basedOnSales: 10 }, NOW);
    await savePricingPreference(db, listing, "max_price", undefined, daysAfter(NOW, 1));
    const p = await getPricingPreference(db, listing);
    expect(p).toMatchObject({ goal: "max_price" });
    expect(p?.recommendedCents).toBeUndefined();
    expect((await db.query("SELECT count(*)::int AS n FROM seller_pricing_preferences")).rows[0]!["n"]).toBe(1);
    await expect(db.query("INSERT INTO seller_pricing_preferences (listing_id, seller_goal) VALUES ($1::uuid,'whenever')", [listing])).rejects.toThrow();
  });
});

const daysAfter = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86_400_000).toISOString();
const hoursAfter = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
