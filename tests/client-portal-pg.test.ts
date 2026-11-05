import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scheduleInspection, respondToInspection, addFinding, shareReport, getReport } from "../src/domain/inspection";
import type { Actor } from "../src/domain/listing-service";
import { buildInspectionPdf } from "../src/domain/client-portal";
import { createPgClientPortalRepository } from "../src/server/client-portal-db";
import { createPgInspectionRepository } from "../src/server/inspection-db";
import { submitOfferPg } from "../src/server/offers-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("client portal on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  const repo = () => createPgClientPortalRepository(t.db);

  async function setup() {
    const ownerId = await addUser(t.db, "owner");
    const buyerId = await addUser(t.db, "buyer");
    const otherId = await addUser(t.db, "buyer");
    const listingId = await addListing(t.db, ownerId, { title: "Cottage", status: "published" });
    const hash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,$4)", [hash, listingId, buyerId, hours(24)]);
    const saved = await submitOfferPg(t.db, { tokenHash: hash, listingId, priceCents: 90_000_000, conditions: ["Finance"], settlementDays: 42, depositCents: 9_000_000, now: new Date().toISOString() });
    return { ownerId, buyerId, otherId, listingId, offerId: saved!.id };
  }

  it("shows an offer only to the buyer who made it and the owner of its listing, and hides the buyer from the owner", async () => {
    const s = await setup();
    const r = repo();
    expect((await r.documentsFor(s.buyerId)).map(d => d.id)).toEqual([s.offerId]);
    expect((await r.documentsFor(s.ownerId)).map(d => d.id)).toEqual([s.offerId]);
    expect(await r.documentsFor(s.otherId)).toEqual([]);
    expect(await r.offerFor(s.otherId, s.offerId)).toBeUndefined();
    expect(await r.offerFor(s.buyerId, s.offerId)).toMatchObject({ viewer: "buyer", buyerName: "Test buyer", events: [{ type: "submitted" }] });
    const ownerCopy = await r.offerFor(s.ownerId, s.offerId);
    expect(ownerCopy).toMatchObject({ viewer: "owner", priceCents: 90_000_000 });
    expect(ownerCopy).not.toHaveProperty("buyerName");
  });

  it("lists a completed inspection report only for people it is shared with, never for a stranger or before it is completed", async () => {
    const s = await setup();
    const inspectorId = String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,'Ian','vendor','active') RETURNING id", [`${randomUUID()}@example.test`])).rows[0]!["id"]);
    const inspRepo = createPgInspectionRepository(t.db);
    const owner: Actor = { userId: s.ownerId, userType: "owner" }, inspector: Actor = { userId: inspectorId, userType: "vendor" };
    const sched = await scheduleInspection(inspRepo, owner, s.listingId, { type: "building", scheduledAt: hours(72), notes: "", userId: inspectorId }, ids);
    if (!sched.ok) throw new Error(JSON.stringify(sched));
    const id = sched.value.id;
    await respondToInspection(inspRepo, inspector, id, { action: "accept" }, ids);
    await addFinding(inspRepo, inspector, id, { area: "Roof", title: "Cracked tiles", severity: "moderate" }, ids);
    await respondToInspection(inspRepo, inspector, id, { action: "complete" }, ids);
    const buyer: Actor = { userId: s.buyerId, userType: "buyer" };

    expect((await repo().documentsFor(s.buyerId)).some(d => d.kind === "inspection")).toBe(false);
    expect(await getReport(inspRepo, buyer, id)).toMatchObject({ ok: false });
    expect(await shareReport(inspRepo, owner, id, { by: "id", userId: s.buyerId }, ids)).toMatchObject({ ok: true });

    const docs = await repo().documentsFor(s.buyerId);
    expect(docs.filter(d => d.kind === "inspection").map(d => d.id)).toEqual([id]);
    expect((await repo().documentsFor(s.otherId)).some(d => d.kind === "inspection")).toBe(false);
    const report = await getReport(inspRepo, buyer, id);
    if (!report.ok) throw new Error("buyer should read the shared report");
    expect(Buffer.from(buildInspectionPdf(report.value, ids.now())).toString("latin1")).toContain("Cracked tiles");
  });

  it("books a viewing on a published listing, blocks duplicates, own listings and drafts, and writes an audit row", async () => {
    const s = await setup();
    const at = hours(48);
    const body = { listingId: s.listingId, kind: "viewing" as const, startsAt: at, note: "" };
    const id = randomUUID();
    expect(await repo().createBooking(s.buyerId, body, id, "c1")).toBe("created");
    expect(await repo().createBooking(s.buyerId, body, randomUUID(), "c2")).toBe("duplicate");
    expect(await repo().createBooking(s.ownerId, body, randomUUID(), "c3")).toBe("not_bookable");
    const draft = await addListing(t.db, s.ownerId, { title: "Draft", status: "draft" });
    expect(await repo().createBooking(s.buyerId, { ...body, listingId: draft }, randomUUID(), "c4")).toBe("not_bookable");
    const audit = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'viewing_booking' AND aggregate_id = $1", [id]);
    expect(audit.rows.map(r => r["event_type"])).toEqual(["booking.requested"]);
  });

  it("limits open requests per person", async () => {
    const s = await setup();
    for (let i = 0; i < 20; i++) expect(await repo().createBooking(s.buyerId, { listingId: s.listingId, kind: "viewing", startsAt: hours(24 + i), note: "" }, randomUUID(), "c")).toBe("created");
    expect(await repo().createBooking(s.buyerId, { listingId: s.listingId, kind: "viewing", startsAt: hours(500), note: "" }, randomUUID(), "c")).toBe("too_many");
  });

  it("lets only the right side change a booking, from the right status", async () => {
    const s = await setup();
    const id = randomUUID();
    await repo().createBooking(s.buyerId, { listingId: s.listingId, kind: "consultation", startsAt: hours(30), note: "Hi" }, id, "c");
    // Visibility: requester and owner see it, a stranger does not.
    expect((await repo().bookingsFor(s.buyerId)).map(b => [b.id, b.role])).toEqual([[id, "requester"]]);
    expect((await repo().bookingsFor(s.ownerId)).map(b => [b.id, b.role, b.otherPartyName])).toEqual([[id, "manager", "Test buyer"]]);
    expect(await repo().bookingsFor(s.otherId)).toEqual([]);
    // A stranger can do nothing; the requester cannot confirm their own request; the owner cannot cancel it.
    expect(await repo().transitionBooking(s.otherId, id, "cancel", "c")).toBe(false);
    expect(await repo().transitionBooking(s.otherId, id, "confirm", "c")).toBe(false);
    expect(await repo().transitionBooking(s.buyerId, id, "confirm", "c")).toBe(false);
    expect(await repo().transitionBooking(s.ownerId, id, "cancel", "c")).toBe(false);
    expect(await repo().transitionBooking(s.ownerId, id, "confirm", "c")).toBe(true);
    expect(await repo().transitionBooking(s.ownerId, id, "decline", "c")).toBe(false); // already decided
    expect(await repo().transitionBooking(s.buyerId, id, "cancel", "c")).toBe(true);
    expect(await repo().transitionBooking(s.buyerId, id, "cancel", "c")).toBe(false);
    const audit = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'viewing_booking' AND aggregate_id = $1 ORDER BY occurred_at, id", [id]);
    expect(audit.rows.map(r => r["event_type"])).toEqual(["booking.requested", "booking.confirmed", "booking.cancelled"]);
  });

  it("never deletes a booking", async () => {
    const s = await setup();
    const id = randomUUID();
    await repo().createBooking(s.buyerId, { listingId: s.listingId, kind: "viewing", startsAt: hours(40), note: "" }, id, "c");
    await expect(t.db.query("DELETE FROM viewing_booking WHERE id = $1", [id])).rejects.toThrow(/permanent record/);
  });
});
