import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marketInsights, valueProperty } from "../src/domain/property-intelligence";
import { chatMarketPg } from "../src/server/chat-assistant-db";
import { combineSources, createPlatformComparablesSource } from "../src/server/property-intelligence";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
const NOW = "2026-11-05T00:00:00.000Z";
const iso = (daysAgo: number) => new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString();

describe.skipIf(!DATABASE_URL)("platform comparables from property_event", () => {
  let t: TestDb;
  let pid: string;
  const addProperty = async (suburb: string, postcode: string, type = "house", beds = 3) => {
    const r = await t.db.query(
      "INSERT INTO property (address_text, state, suburb, postcode, property_type, bedrooms, bathrooms, car_spaces, land_area_sqm) VALUES ($1,'QLD',$2,$3,$4,$5,2,1,450) RETURNING id",
      [`${randomUUID()} Test St`, suburb, postcode, type, beds]
    );
    return String(r.rows[0]!["id"]);
  };
  const event = (property: string, type: string, daysAgo: number, cents: number | null, source = "platform") =>
    t.db.query("INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source) VALUES ($1::uuid,$2,$3::timestamptz,$4,$5)", [property, type, iso(daysAgo), cents, source]);

  beforeAll(async () => {
    t = await createTestDb();
    for (let i = 0; i < 8; i++) {
      pid = await addProperty("Paddington", "4064");
      await event(pid, "listed", 30 + i * 10 + 40, null);
      await event(pid, "sold", 30 + i * 10, 120_000_000 + i * 1_000_000);
    }
    const other = await addProperty("Elsewhere", "9999");
    await event(other, "sold", 20, 50_000_000);
    const unverified = await addProperty("Paddington", "4064");
    await event(unverified, "sold", 20, 900_000_000, "owner_supplied");
    await event(unverified, "sold", 25, 900_000_000, "licensed_third_party");
    const rented = await addProperty("Paddington", "4064", "unit", 2);
    await event(rented, "rented", 15, 65_000);
  }, 60_000);
  afterAll(async () => { await t?.close(); });

  const subject = { transactionType: "sale" as const, propertyType: "house", suburb: "paddington", postcode: "4064", bedrooms: 3 };

  it("returns this area's platform sales with days on market, and no owner-supplied or licensed rows", async () => {
    const rows = await createPlatformComparablesSource(t.db).find(subject, NOW);
    const sales = rows.filter(r => r.transactionType === "sale");
    expect(sales).toHaveLength(8);
    expect(sales.every(r => r.suburb === "Paddington" && r.priceCents < 200_000_000)).toBe(true);
    expect(sales[0]).toMatchObject({ daysOnMarket: 40, areaSqm: 450, bedrooms: 3, parking: 1 });
    expect(rows.some(r => r.transactionType === "rent" && r.priceCents === 65_000)).toBe(true);
  });
  it("feeds the valuation and the market figures", async () => {
    const comps = await combineSources([createPlatformComparablesSource(t.db)]).find(subject, NOW);
    expect(valueProperty(subject, comps, NOW)).toMatchObject({ comparablesUsed: expect.any(Number) });
    expect(marketInsights(subject, comps, NOW)).toMatchObject({ state: "ready", sampleSize: 8, medianDaysOnMarket: 40 });
  });
  it("gives the chat a suburb brief, and nothing when the area has too little data", async () => {
    expect(await chatMarketPg(t.db, { suburb: "Paddington", postcode: "4064", transactionType: "sale", propertyType: "house" })).toMatchObject({ area: "Paddington", sampleSize: 8 });
    expect(await chatMarketPg(t.db, { suburb: "Nowhere", postcode: "1234", transactionType: "sale", propertyType: "house" })).toBeUndefined();
    expect(await chatMarketPg(t.db, { transactionType: "sale", propertyType: "house" })).toBeUndefined();
  });
  it("never throws: a broken database gives no comparables", async () => {
    const broken = { query: async () => { throw new Error("down"); } };
    expect(await createPlatformComparablesSource(broken).find(subject, NOW)).toEqual([]);
  });
});

describe("combineSources", () => {
  it("counts the same id once and ignores a failing source", async () => {
    const row = { id: "a", transactionType: "sale" as const, propertyType: "house", priceCents: 1, date: NOW, suburb: "X" };
    const src = (rows: unknown[]) => ({ id: "s", find: async () => rows as never[] });
    const bad = { id: "bad", find: async () => { throw new Error("x"); } };
    expect(await combineSources([src([row]), src([row, { ...row, id: "b" }]), bad]).find({ transactionType: "sale", propertyType: "house" }, NOW)).toHaveLength(2);
  });
});
