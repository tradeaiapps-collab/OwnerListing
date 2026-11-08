import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgOpenInspectionRepo } from "../src/server/open-inspection-db";
import { actOnBookings, bookInspection, cancelOwnBooking, publishTime, removeTime } from "../src/server/open-inspection-service";
import { runOpenInspectionReminders } from "../src/server/open-inspection-notify";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it). Sydney is UTC+11 in November.
describe.skipIf(!DATABASE_URL)("open inspection scheduling on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const repo = () => createPgOpenInspectionRepo(t.db);
  // A Thursday, so the next Saturday is 2026-11-07 (10:00 Sydney = 2026-11-06T23:00Z).
  const NOW = "2026-11-05T00:00:00.000Z";
  const SAT_10 = "2026-11-06T23:00:00.000Z", SAT_1030 = "2026-11-06T23:30:00.000Z";
  const rule = { type: "rule", recurrence: "weekly", dayOfWeek: 6, start: "10:00", end: "14:00", slotMinutes: 30 };
  const kinds = async (user: string) => (await t.db.query("SELECT kind FROM notification WHERE user_id = $1 ORDER BY created_at, id", [user])).rows.map(r => String(r["kind"]));
  const buyerBody = (startsAt: string, extra: Record<string, unknown> = {}) => ({ listingId: "", startsAt, name: "Sam Buyer", phone: "0412345678", email: "sam@example.com", notes: "Kitchen reno", ...extra });

  async function setup(withAgent = false) {
    const owner = await addUser(t.db, "owner"), buyer = await addUser(t.db, "buyer"), other = await addUser(t.db, "buyer"), stranger = await addUser(t.db, "agent");
    const agent = await addUser(t.db, "agent");
    const listingId = await addListing(t.db, owner, { status: "published", address_text: "12 Harbour St, Sydney" });
    if (withAgent) await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listingId, agent, owner]);
    return { owner, buyer, other, agent, stranger, listingId, o: { userId: owner, userType: "owner" as const }, b: { userId: buyer, userType: "buyer" as const }, b2: { userId: other, userType: "buyer" as const }, a: { userId: agent, userType: "agent" as const }, s: { userId: stranger, userType: "agent" as const } };
  }

  it("lets the owner or appointed agent publish times, and nobody else", async () => {
    const s = await setup(true);
    expect((await publishTime(repo(), s.s, s.listingId, rule, NOW, t.db)).ok).toBe(false);
    expect((await publishTime(repo(), s.b, s.listingId, rule, NOW, t.db)).ok).toBe(false);
    expect((await publishTime(repo(), s.a, s.listingId, rule, NOW, t.db)).ok).toBe(true);
    const overlap = await publishTime(repo(), s.o, s.listingId, { ...rule, start: "13:00", end: "15:00" }, NOW, t.db);
    expect(overlap).toMatchObject({ ok: false, code: "conflict" });
    const slots = await repo().freeSlots((await repo().publishedListing(s.listingId))!, NOW);
    expect(slots[0]).toMatchObject({ startsAt: SAT_10, spotsLeft: 1 });
    const audits = await t.db.query("SELECT count(*)::int AS n FROM audit_event WHERE aggregate_type = 'open_inspection_availability' AND event_type = 'open_inspection.times_published'");
    expect(audits.rows[0]!["n"]).toBe(1);
  });

  it("books a slot once, takes it off the calendar, confirms to the buyer and alerts the agent", async () => {
    const s = await setup(true);
    await publishTime(repo(), s.o, s.listingId, rule, NOW, t.db);
    const r = await bookInspection(repo(), s.b, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db);
    expect(r.ok).toBe(true);
    expect(await bookInspection(repo(), s.b2, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db)).toMatchObject({ ok: false, code: "conflict" });
    expect((await repo().freeSlots((await repo().publishedListing(s.listingId))!, NOW)).map(x => x.startsAt)).not.toContain(SAT_10);
    expect(await kinds(s.buyer)).toEqual(["open_inspection_confirmed"]);
    expect(await kinds(s.agent)).toEqual(["open_inspection_new"]);
    expect(await kinds(s.owner)).toEqual(["open_inspection_new"]);
    const mine = await repo().buyerBookings(s.buyer);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ address: "12 Harbour St, Sydney", buyerName: "Sam Buyer", notes: "Kitchen reno", status: "booked", contactName: "Test agent" });
  });

  it("refuses booking times that are not offered, own listings, non-buyers and unpublished listings", async () => {
    const s = await setup();
    await publishTime(repo(), s.o, s.listingId, rule, NOW, t.db);
    expect(await bookInspection(repo(), s.b, buyerBody("2026-11-07T01:07:00.000Z", { listingId: s.listingId }), NOW, t.db)).toMatchObject({ ok: false, code: "conflict" });
    expect((await bookInspection(repo(), s.a, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db)).ok).toBe(false);
    const draft = await addListing(t.db, s.owner, { status: "draft" });
    expect((await bookInspection(repo(), s.b, buyerBody(SAT_10, { listingId: draft }), NOW, t.db)).ok).toBe(false);
  });

  it("never overbooks a slot when two buyers race for it", async () => {
    const s = await setup();
    await publishTime(repo(), s.o, s.listingId, rule, NOW, t.db);
    const results = await Promise.all([s.b, s.b2].map(a => bookInspection(repo(), a, buyerBody(SAT_1030, { listingId: s.listingId }), NOW, t.db)));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const n = await t.db.query("SELECT count(*)::int AS n FROM open_inspection_booking WHERE listing_id = $1 AND status = 'booked'", [s.listingId]);
    expect(n.rows[0]!["n"]).toBe(1);
  });

  it("allows several bookings on a slot with capacity above one", async () => {
    const s = await setup();
    await publishTime(repo(), s.o, s.listingId, { ...rule, capacity: 2 }, NOW, t.db);
    expect((await bookInspection(repo(), s.b, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db)).ok).toBe(true);
    expect((await bookInspection(repo(), s.b2, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db)).ok).toBe(true);
    expect((await bookInspection(repo(), { userId: await addUser(t.db, "buyer"), userType: "buyer" }, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db)).ok).toBe(false);
  });

  it("lets a buyer cancel only their own upcoming booking and tells the agent, then frees the slot", async () => {
    const s = await setup();
    await publishTime(repo(), s.o, s.listingId, rule, NOW, t.db);
    const id = ((await bookInspection(repo(), s.b, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db)) as { value: { id: string } }).value.id;
    expect((await cancelOwnBooking(repo(), s.b2, id, t.db)).ok).toBe(false);
    expect((await cancelOwnBooking(repo(), s.b, id, t.db)).ok).toBe(true);
    expect((await cancelOwnBooking(repo(), s.b, id, t.db)).ok).toBe(false);
    expect(await kinds(s.owner)).toEqual(["open_inspection_new", "open_inspection_cancelled"]);
    expect((await repo().freeSlots((await repo().publishedListing(s.listingId))!, NOW)).map(x => x.startsAt)).toContain(SAT_10);
  });

  it("blocking a time cancels bookings inside it and tells the buyer the next free times", async () => {
    const s = await setup();
    await publishTime(repo(), s.o, s.listingId, rule, NOW, t.db);
    await bookInspection(repo(), s.b, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db);
    const r = await publishTime(repo(), s.o, s.listingId, { type: "block", startsAt: SAT_10, endsAt: "2026-11-07T00:00:00.000Z", note: "Private viewing" }, NOW, t.db);
    expect(r).toMatchObject({ ok: true, value: { cancelled: 1 } });
    expect(await kinds(s.buyer)).toEqual(["open_inspection_confirmed", "open_inspection_cancelled"]);
    const note = await t.db.query("SELECT body FROM notification WHERE user_id = $1 AND kind = 'open_inspection_cancelled'", [s.buyer]);
    expect(String(note.rows[0]!["body"])).toContain("Next free times");
    expect((await repo().freeSlots((await repo().publishedListing(s.listingId))!, NOW)).map(x => x.startsAt)).not.toContain(SAT_10);
  });

  it("applies agent actions only on managed listings, and only where they fit", async () => {
    const s = await setup(true);
    await publishTime(repo(), s.o, s.listingId, rule, NOW, t.db);
    const id = ((await bookInspection(repo(), s.b, buyerBody(SAT_10, { listingId: s.listingId }), NOW, t.db)) as { value: { id: string } }).value.id;
    expect((await actOnBookings(repo(), s.s, { ids: [id], action: "cancel" }, NOW, t.db))).toMatchObject({ ok: true, value: { changed: 0 } });
    expect((await actOnBookings(repo(), s.b, { ids: [id], action: "cancel" }, NOW, t.db)).ok).toBe(false);
    expect((await repo().buyerBookings(s.buyer))[0]!.status).toBe("booked");
    // A future booking cannot be completed or marked a no-show yet.
    expect(await actOnBookings(repo(), s.a, { ids: [id], action: "no_show" }, NOW, t.db)).toMatchObject({ value: { changed: 0 } });
    expect(await actOnBookings(repo(), s.a, { ids: [id], action: "remind" }, NOW, t.db)).toMatchObject({ value: { changed: 1 } });
    expect((await kinds(s.buyer)).filter(k => k === "open_inspection_reminder_24h")).toHaveLength(1);
    expect(await actOnBookings(repo(), s.a, { ids: [id], action: "cancel" }, NOW, t.db)).toMatchObject({ value: { changed: 1 } });
    expect(await actOnBookings(repo(), s.a, { ids: [id], action: "cancel" }, NOW, t.db)).toMatchObject({ value: { changed: 0 } });
    expect(await kinds(s.buyer)).toContain("open_inspection_cancelled");
  });

  it("marks past bookings completed or no-show", async () => {
    const s = await setup();
    const past = async (offsetH: number) => {
      const id = (await t.db.query(
        "INSERT INTO open_inspection_booking (listing_id, buyer_id, buyer_name, buyer_email, starts_at, ends_at, created_at) VALUES ($1,$2,'Sam','s@e.test', now() - $3 * interval '1 hour', now() - $3 * interval '1 hour' + interval '30 minutes', now() - interval '5 days') RETURNING id", [s.listingId, s.buyer, offsetH])).rows[0]!["id"] as string;
      return id;
    };
    const [a, b] = [await past(3), await past(2)];
    expect(await actOnBookings(repo(), s.o, { ids: [a], action: "complete" }, new Date().toISOString(), t.db)).toMatchObject({ value: { changed: 1 } });
    expect(await actOnBookings(repo(), s.o, { ids: [b], action: "no_show" }, new Date().toISOString(), t.db)).toMatchObject({ value: { changed: 1 } });
    expect(await actOnBookings(repo(), s.o, { ids: [a], action: "no_show" }, new Date().toISOString(), t.db)).toMatchObject({ value: { changed: 0 } });
    const rows = await repo().managerBookings(s.owner, new Date(Date.now() - 86_400_000).toISOString(), new Date().toISOString());
    expect(rows.map(r => r.status).sort()).toEqual(["completed", "no_show"]);
  });

  it("removes published times without touching bookings, and refuses the permanent record being deleted", async () => {
    const s = await setup();
    const r = await publishTime(repo(), s.o, s.listingId, rule, NOW, t.db);
    const ruleId = (r as { value: { id: string } }).value.id;
    expect((await removeTime(repo(), s.s, s.listingId, "rule", ruleId)).ok).toBe(false);
    expect((await removeTime(repo(), s.o, s.listingId, "rule", ruleId)).ok).toBe(true);
    expect((await repo().freeSlots((await repo().publishedListing(s.listingId))!, NOW))).toEqual([]);
    await t.db.query("INSERT INTO open_inspection_booking (listing_id, buyer_id, buyer_name, buyer_email, starts_at, ends_at) VALUES ($1,$2,'Sam','s@e.test', now(), now() + interval '30 minutes')", [s.listingId, s.buyer]);
    await expect(t.db.query("DELETE FROM open_inspection_booking")).rejects.toThrow(/permanent record/);
  });

  it("sends each reminder once: 24 hours before, then 1 hour before, and not for a booking made too late", async () => {
    const s = await setup();
    await t.db.query("UPDATE open_inspection_booking SET status = 'cancelled' WHERE listing_id <> $1", [s.listingId]); // the job is global; other tests' bookings are out of scope here
    const at = (iso: string, createdIso: string) => t.db.query("INSERT INTO open_inspection_booking (listing_id, buyer_id, buyer_name, buyer_email, starts_at, ends_at, created_at) VALUES ($1,$2,'Sam','s@e.test',$3,$3::timestamptz + interval '30 minutes',$4) RETURNING id", [s.listingId, s.buyer, iso, createdIso]);
    await at("2026-11-07T00:00:00.000Z", "2026-11-01T00:00:00.000Z"); // booked days ahead
    await at("2026-11-07T00:30:00.000Z", "2026-11-06T20:00:00.000Z"); // booked 4 hours before: no 24 hour reminder
    await at("2026-11-08T00:00:00.000Z", "2026-11-01T00:00:00.000Z"); // too far away
    const count = async () => (await kinds(s.buyer)).reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {});
    expect(await runOpenInspectionReminders(t.db, "2026-11-06T01:00:00.000Z")).toEqual({ day: 1, hour: 0 });
    expect(await runOpenInspectionReminders(t.db, "2026-11-06T01:15:00.000Z")).toEqual({ day: 0, hour: 0 });
    expect(await runOpenInspectionReminders(t.db, "2026-11-06T23:00:00.000Z")).toEqual({ day: 0, hour: 1 });
    expect(await runOpenInspectionReminders(t.db, "2026-11-06T23:15:00.000Z")).toEqual({ day: 0, hour: 1 }); // the late booking's 1 hour reminder
    expect(await runOpenInspectionReminders(t.db, "2026-11-06T23:30:00.000Z")).toEqual({ day: 0, hour: 0 });
    expect(await count()).toEqual({ open_inspection_reminder_24h: 1, open_inspection_reminder_1h: 2 });
  });

  it("does not remind cancelled bookings", async () => {
    const s = await setup();
    await t.db.query("INSERT INTO open_inspection_booking (listing_id, buyer_id, buyer_name, buyer_email, starts_at, ends_at, created_at, status) VALUES ($1,$2,'Sam','s@e.test','2026-11-07T00:00:00Z','2026-11-07T00:30:00Z','2026-11-01T00:00:00Z','cancelled')", [s.listingId, s.buyer]);
    expect(await runOpenInspectionReminders(t.db, "2026-11-06T01:00:00.000Z")).toEqual({ day: 0, hour: 0 });
  });
});
