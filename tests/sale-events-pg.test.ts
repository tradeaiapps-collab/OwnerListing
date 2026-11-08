import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marketInsights } from "../src/domain/property-intelligence";
import { statusesAllowing } from "../src/domain/offer-decision";
import { decideOfferPg } from "../src/server/offer-flow-db";
import { submitOfferPg } from "../src/server/offers-db";
import { createPlatformComparablesSource } from "../src/server/property-intelligence";
import { backfillAcceptedOfferEventsPg, listSaleEventsPg, recordAcceptedOfferEventPg, recordManualEventPg, voidSaleEventPg } from "../src/server/sale-events-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
const NOW = new Date(Date.now() + 2 * 86_400_000).toISOString();
const THEN = new Date(Date.now() + 86_400_000).toISOString();

describe.skipIf(!DATABASE_URL)("sold and rented events (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  async function accepted(o: { type?: "sale" | "rent"; suburb?: string; address?: string; agent?: boolean; price?: number; accept?: boolean } = {}) {
    const owner = await addUser(db, "owner");
    const buyer = await addUser(db, "buyer");
    const listingId = await addListing(db, owner, { status: "published", transaction_type: o.type ?? "sale", suburb: o.suburb ?? "Paddington", postcode: "4064", jurisdiction: "QLD", address_text: o.address ?? `${randomUUID()} Test St`, bedrooms: 3, bathrooms: 2, parking: 1 });
    let agent: string | undefined;
    if (o.agent) {
      agent = await addUser(db, "agent");
      await db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    }
    const tokenHash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,$4)", [tokenHash, listingId, buyer, new Date(Date.parse(NOW) + 86_400_000).toISOString()]);
    const price = o.price ?? 90_000_000;
    const saved = await submitOfferPg(db, { tokenHash, listingId, priceCents: price, conditions: [], settlementDays: 30, depositCents: price / 10, now: THEN });
    const offerId = saved!.id;
    if (o.accept !== false) await decideOfferPg(db, listingId, offerId, owner, statusesAllowing("accept"), "accepted", NOW);
    return { owner, buyer, agent, listingId, offerId, price };
  }
  const events = async (offerId: string) => (await db.query("SELECT * FROM property_event WHERE offer_id = $1::uuid", [offerId])).rows;

  it("writes a sold event with the accepted price, date, agent and buyer, and creates the property", async () => {
    const a = await accepted({ agent: true, price: 91_000_000 });
    expect(await recordAcceptedOfferEventPg(db, a.offerId)).toBe(true);
    const [e] = await events(a.offerId);
    expect(e).toMatchObject({ event_type: "sold", amount_cents: "91000000", source: "platform", origin: "accepted_offer", agent_user_id: a.agent, buyer_user_id: a.buyer, listing_id: a.listingId, voided_at: null });
    expect(new Date(e!["occurred_at"] as Date).toISOString()).toBe(NOW);
    const p = (await db.query("SELECT p.suburb, p.state, p.bedrooms FROM property p JOIN property_listing l ON l.property_id = p.id WHERE l.id = $1", [a.listingId])).rows[0];
    expect(p).toMatchObject({ suburb: "Paddington", bedrooms: 3 });
  });

  it("writes a rented event for a rental listing, with no agent when none is appointed", async () => {
    const a = await accepted({ type: "rent", price: 65_000 });
    await recordAcceptedOfferEventPg(db, a.offerId);
    expect((await events(a.offerId))[0]).toMatchObject({ event_type: "rented", amount_cents: "65000", agent_user_id: null });
  });

  it("takes the price of the accepted terms, not the original offer", async () => {
    const a = await accepted({ accept: false, price: 80_000_000 });
    await db.query("UPDATE formal_offer SET status = 'countered' WHERE id = $1", [a.offerId]);
    await db.query("UPDATE formal_offer SET status = 'accepted' WHERE id = $1", [a.offerId]);
    await db.query(
      "INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, price_cents, settlement_days, deposit_cents, from_status, to_status, occurred_at) VALUES ($1,'accepted','owner',$2,84000000,30,8400000,'countered','accepted',$3)",
      [a.offerId, a.owner, NOW]
    );
    await recordAcceptedOfferEventPg(db, a.offerId);
    expect((await events(a.offerId))[0]).toMatchObject({ amount_cents: "84000000" });
  });

  it("is idempotent, ignores offers that are not accepted, and reuses the property for a relisting", async () => {
    const a = await accepted();
    expect(await recordAcceptedOfferEventPg(db, a.offerId)).toBe(true);
    expect(await recordAcceptedOfferEventPg(db, a.offerId)).toBe(false);
    expect(await events(a.offerId)).toHaveLength(1);
    const pending = await accepted({ accept: false });
    expect(await recordAcceptedOfferEventPg(db, pending.offerId)).toBe(false);
    const addr = "77 Same St";
    const x = await accepted({ address: addr }), y = await accepted({ address: addr.toUpperCase() });
    await recordAcceptedOfferEventPg(db, x.offerId); await recordAcceptedOfferEventPg(db, y.offerId);
    const props = (await db.query("SELECT DISTINCT property_id FROM property_listing WHERE id = ANY($1::uuid[])", [[x.listingId, y.listingId]])).rows;
    expect(props).toHaveLength(1);
  });

  it("a voided event leaves valuations, stays in the log, and is not brought back by a sweep", async () => {
    const suburb = "Voidville";
    const made = [];
    for (let i = 0; i < 6; i++) { const a = await accepted({ suburb, price: 100_000_000 + i * 1_000_000 }); await recordAcceptedOfferEventPg(db, a.offerId); made.push(a); }
    const subject = { transactionType: "sale" as const, propertyType: "house", suburb, postcode: "4064", bedrooms: 3 };
    const count = async () => (await createPlatformComparablesSource(db).find(subject, NOW)).filter(c => c.suburb === suburb).length;
    expect(await count()).toBe(6);
    expect(marketInsights(subject, await createPlatformComparablesSource(db).find(subject, NOW), NOW)).toMatchObject({ state: "ready" });
    const id = String((await events(made[0]!.offerId))[0]!["id"]);
    expect(await voidSaleEventPg(db, id, "staff-1", "Sale fell through.", NOW)).toMatchObject({ outcome: "voided" });
    expect(await voidSaleEventPg(db, id, "staff-1", "again", NOW)).toEqual({ outcome: "already_voided" });
    expect(await voidSaleEventPg(db, randomUUID(), "staff-1", "x", NOW)).toEqual({ outcome: "not_found" });
    expect(await count()).toBe(5);
    expect((await backfillAcceptedOfferEventsPg(db)).written).toBe(0);
    expect(await events(made[0]!.offerId)).toHaveLength(1);
    const voided = await listSaleEventsPg(db, { status: "voided", q: suburb }, true);
    expect(voided.rows).toHaveLength(1);
    expect(voided.rows[0]!.voided).toMatchObject({ reason: "Sale fell through.", by: "staff-1" });
  });

  it("the sweep writes events for accepted offers that have none", async () => {
    const a = await accepted(), b = await accepted();
    await db.query("ALTER TABLE property_event DISABLE TRIGGER property_event_sale_guard");
    await db.query("DELETE FROM property_event WHERE offer_id = ANY($1::uuid[])", [[a.offerId, b.offerId]]);
    await db.query("ALTER TABLE property_event ENABLE TRIGGER property_event_sale_guard");
    const r = await backfillAcceptedOfferEventsPg(db);
    expect(r.written).toBeGreaterThanOrEqual(2);
    expect(await events(a.offerId)).toHaveLength(1);
    expect(await events(b.offerId)).toHaveLength(1);
  });

  it("staff entries create or reuse the property, count in comparables, and carry who recorded them", async () => {
    const entry = { eventType: "sold" as const, amountCents: 77_000_000, occurredAt: "2025-06-01T00:00:00.000Z", source: "public_record" as const, address: "9 Old Rd", state: "QLD" as const, suburb: "Manualton", postcode: "4000", propertyType: "house" as const, bedrooms: 3, counterparty: "Jane Citizen", note: "From title search" };
    const id1 = await recordManualEventPg(db, entry, "staff-9");
    const id2 = await recordManualEventPg(db, { ...entry, eventType: "rented", amountCents: 55_000, occurredAt: "2025-07-01T00:00:00.000Z", address: "9 OLD RD" }, "staff-9");
    expect(id1).not.toBe(id2);
    expect((await db.query("SELECT count(*)::int AS n FROM property WHERE suburb = 'Manualton'")).rows[0]!["n"]).toBe(1);
    const comps = await createPlatformComparablesSource(db).find({ transactionType: "sale", propertyType: "house", suburb: "Manualton", postcode: "4000" }, NOW);
    expect(comps.filter(c => c.transactionType === "sale")).toHaveLength(1);
    const page = await listSaleEventsPg(db, { origin: "staff_manual", q: "Manualton" }, false);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({ recordedBy: "staff-9", counterparty: "J*** C***", note: "From title search" });
    expect((await listSaleEventsPg(db, { origin: "staff_manual", q: "Manualton" }, true)).rows[0]!.counterparty).toBe("Jane Citizen");
  });

  it("filters and pages the log, newest first, and masks names without full access", async () => {
    const a = await accepted({ agent: true, suburb: "Pageville" });
    await recordAcceptedOfferEventPg(db, a.offerId);
    for (let i = 0; i < 55; i++) {
      await recordManualEventPg(db, { eventType: "sold", amountCents: 50_000_000 + i, occurredAt: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(), source: "public_record", address: `${i} Page St`, state: "QLD", suburb: "Pageville", postcode: "4001", propertyType: "unit" }, "s");
    }
    const first = await listSaleEventsPg(db, { q: "Pageville" }, false);
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    expect(first.rows[0]!.origin).toBe("accepted_offer");
    expect(first.rows[0]!.agent!.name).toBe("T*** a***");
    const second = await listSaleEventsPg(db, { q: "Pageville", cursor: first.nextCursor! }, false);
    expect(second.rows).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map(r => r.id)).size).toBe(56);
    expect((await listSaleEventsPg(db, { q: "Pageville", type: "rented" }, false)).rows).toHaveLength(0);
  });

  it("cannot be deleted or edited, only voided", async () => {
    const id = await recordManualEventPg(db, { eventType: "sold", amountCents: 1_000_000, occurredAt: "2024-01-01T00:00:00.000Z", source: "public_record", address: "1 Guard St", state: "VIC", suburb: "Guardton", postcode: "3000", propertyType: "unit" }, "s");
    await expect(db.query("DELETE FROM property_event WHERE id = $1", [id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.query("UPDATE property_event SET amount_cents = 2 WHERE id = $1", [id])).rejects.toThrow(/only be voided/);
    await voidSaleEventPg(db, id, "s", "Entered twice.", NOW);
    await expect(db.query("UPDATE property_event SET void_reason = 'x' WHERE id = $1", [id])).rejects.toThrow(/voided event/);
  });
});
