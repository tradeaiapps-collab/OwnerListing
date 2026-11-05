import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptBooking, applyAsInspector, cancelBooking, requestInspection, reviewInspector } from "../src/domain/inspection-marketplace";
import type { Actor } from "../src/domain/listing-service";
import {
  decideMessage, draftBookingMessages, listTemplatesPg, queueForAuthor, resetTemplatePg, runDueSchedulingMessages, saveTemplatePg
} from "../src/server/elena-scheduling-db";
import { createPgBookingRepository } from "../src/server/inspection-marketplace-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("Elena scheduling messages on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const slot = (days: number) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(1, 0, 0, 0); return d.toISOString(); };
  const user = async (type: string, name = `Test ${type}`) =>
    String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,$3,'active') RETURNING id", [`${randomUUID()}@example.test`, name, type])).rows[0]!["id"]);
  const env = {};
  let repo!: ReturnType<typeof createPgBookingRepository>;
  beforeAll(() => { repo = createPgBookingRepository(t.db); });

  /** A scheduled booking `days` ahead, accepted by a fresh approved inspector. */
  async function booked(days: number, notes = "") {
    const ownerId = await addUser(t.db, "owner"), buyerId = await user("buyer", "Sam Buyer");
    await t.db.query("INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, id_verified_at) VALUES ($1, now(), now(), now())", [buyerId]);
    const listingId = await addListing(t.db, ownerId, { status: "published", jurisdiction: "NSW", title: "Cottage" });
    const buyer: Actor = { userId: buyerId, userType: "buyer" };
    const req = await requestInspection(repo, buyer, listingId, { slots: [slot(days)], notes }, ids);
    if (!req.ok) throw new Error(req.message);
    const inspectorId = await user("vendor", "Pat Inspector");
    const insp: Actor = { userId: inspectorId, userType: "vendor" };
    await applyAsInspector(repo, insp, { businessName: "Sound Checks", jurisdictions: ["NSW"] }, ids);
    await reviewInspector(repo, await addUser(t.db, "admin"), inspectorId, "approved", "", ids);
    const ok = await acceptBooking(repo, insp, req.value.id, slot(days), ids);
    if (!ok.ok) throw new Error(ok.message);
    return { bookingId: req.value.id, buyer, insp };
  }
  const inbox = async (userId: string) => (await t.db.query("SELECT body FROM notification WHERE user_id = $1 AND kind = 'scheduling_message'", [userId])).rows.map(r => String(r["body"]));

  it("drafts a confirmation now and a 24-hour reminder later, personalised, and sends nothing until the agent decides", async () => {
    const b = await booked(4, "Please check the roof");
    expect(await draftBookingMessages(t.db, b.bookingId, new Date().toISOString(), env)).toBe(2);
    expect(await draftBookingMessages(t.db, b.bookingId, new Date().toISOString(), env)).toBe(0); // repeat does nothing
    const q = await queueForAuthor(t.db, b.insp.userId);
    expect(q.suggestions).toHaveLength(1);
    const s = q.suggestions[0]!;
    expect(s).toMatchObject({ kind: "booking_confirmation", status: "suggested" });
    expect(s.draftBody).toContain("Sam");
    expect(s.draftBody).toContain("Sound Checks");
    expect(s.draftBody).toContain("Cottage");
    expect(s.draftBody).toContain("Please check the roof");
    expect(s.draftBody).not.toMatch(/\[[a-z_]+\]/);
    expect(q.history.map(h => [h.kind, h.status])).toEqual([["reminder_24h", "scheduled"]]);
    expect(await inbox(b.buyer.userId)).toEqual([]);
  });

  it("send delivers the final text to the buyer, keeps both texts, records edited, and cannot be decided twice or by someone else", async () => {
    const b = await booked(4);
    await draftBookingMessages(t.db, b.bookingId, new Date().toISOString(), env);
    const s = (await queueForAuthor(t.db, b.insp.userId)).suggestions[0]!;
    const stranger = await user("vendor");
    expect(await decideMessage(t.db, stranger, s.id, { action: "send" }, undefined, env)).toMatchObject({ ok: false, code: "not_found" });
    expect(await decideMessage(t.db, b.insp.userId, s.id, { action: "send", body: "  " }, undefined, env)).toMatchObject({ ok: false, code: "invalid" });
    expect(await decideMessage(t.db, b.insp.userId, s.id, { action: "send", body: "Hi Sam, see you Saturday!" }, undefined, env)).toEqual({ ok: true, sent: true });
    expect(await decideMessage(t.db, b.insp.userId, s.id, { action: "skip" }, undefined, env)).toMatchObject({ ok: false, code: "not_found" });
    expect(await inbox(b.buyer.userId)).toEqual(["Hi Sam, see you Saturday!"]);
    const row = (await t.db.query("SELECT draft_body, final_body, edited, status FROM elena_scheduled_message WHERE id = $1", [s.id])).rows[0]!;
    expect(row).toMatchObject({ final_body: "Hi Sam, see you Saturday!", edited: true, status: "sent" });
    expect(String(row["draft_body"])).toBe(s.draftBody);
    expect(Number((await t.db.query("SELECT count(*) AS n FROM audit_event WHERE event_type = 'elena_message.sent' AND aggregate_id = $1", [s.id])).rows[0]!["n"])).toBe(1);
    await expect(t.db.query("DELETE FROM elena_scheduled_message WHERE id = $1", [s.id])).rejects.toThrow();
  });

  it("skip sends nothing and sending as drafted is not marked edited", async () => {
    const b = await booked(5);
    await draftBookingMessages(t.db, b.bookingId, new Date().toISOString(), env);
    const s = (await queueForAuthor(t.db, b.insp.userId)).suggestions[0]!;
    expect(await decideMessage(t.db, b.insp.userId, s.id, { action: "skip" }, undefined, env)).toEqual({ ok: true, sent: false });
    expect(await inbox(b.buyer.userId)).toEqual([]);
    const b2 = await booked(5);
    await draftBookingMessages(t.db, b2.bookingId, new Date().toISOString(), env);
    const s2 = (await queueForAuthor(t.db, b2.insp.userId)).suggestions[0]!;
    await decideMessage(t.db, b2.insp.userId, s2.id, { action: "send" }, undefined, env);
    expect((await queueForAuthor(t.db, b2.insp.userId)).history.find(h => h.status === "sent")).toMatchObject({ status: "sent", edited: false });
  });

  it("the tick turns a due reminder into a suggestion and expires drafts when the booking is cancelled", async () => {
    const b = await booked(4);
    await draftBookingMessages(t.db, b.bookingId, new Date().toISOString(), env);
    const at = (await t.db.query("SELECT scheduled_at FROM inspection_booking WHERE id = $1", [b.bookingId])).rows[0]!["scheduled_at"] as Date;
    const early = new Date(at.getTime() - 12 * 3600_000).toISOString(); // reminder due, visit not yet started
    expect((await runDueSchedulingMessages(t.db, early, env)).suggested).toBeGreaterThanOrEqual(1); // other tests' reminders may be due too
    expect((await queueForAuthor(t.db, b.insp.userId)).suggestions.map(x => x.kind).sort()).toEqual(["booking_confirmation", "reminder_24h"]);

    const c = await booked(4);
    await draftBookingMessages(t.db, c.bookingId, new Date().toISOString(), env);
    expect((await cancelBooking(repo, c.buyer, c.bookingId, ids)).ok).toBe(true);
    const r = await runDueSchedulingMessages(t.db, new Date().toISOString(), env);
    expect(r.expired).toBe(2);
    const q = await queueForAuthor(t.db, c.insp.userId);
    expect(q.suggestions).toEqual([]);
    expect(q.history.map(h => h.status)).toEqual(["expired", "expired"]);
    // A cancelled booking's draft can no longer be sent.
    expect(await decideMessage(t.db, c.insp.userId, q.history[0]!.id, { action: "send" }, undefined, env)).toMatchObject({ ok: false });
  });

  it("uses the agent's template over the platform one, and resetting goes back down a level", async () => {
    const staff = await addUser(t.db, "admin");
    await saveTemplatePg(t.db, null, { kind: "booking_confirmation", voice: "formal", body: "PLATFORM [buyer_name] at [property_address]" }, staff);
    const a = await booked(4);
    await draftBookingMessages(t.db, a.bookingId, new Date().toISOString(), env);
    expect((await queueForAuthor(t.db, a.insp.userId)).suggestions[0]!.draftBody).toBe("PLATFORM Sam at " + (await t.db.query("SELECT address_text FROM property_listing WHERE id = (SELECT listing_id FROM inspection_booking WHERE id = $1)", [a.bookingId])).rows[0]!["address_text"]);

    const b = await booked(4);
    await saveTemplatePg(t.db, b.insp.userId, { kind: "booking_confirmation", voice: "casual", body: "MINE [buyer_name], love [agent_name]" }, b.insp.userId);
    await saveTemplatePg(t.db, b.insp.userId, { kind: "booking_confirmation", voice: "casual", body: "MINE again [buyer_name], love [agent_name]" }, b.insp.userId);
    expect(await listTemplatesPg(t.db, b.insp.userId)).toHaveLength(1);
    await draftBookingMessages(t.db, b.bookingId, new Date().toISOString(), env);
    expect((await queueForAuthor(t.db, b.insp.userId)).suggestions[0]!.draftBody).toBe("MINE again Sam, love Sound Checks");
    expect(await resetTemplatePg(t.db, b.insp.userId, "booking_confirmation")).toBe(true);
    expect(await resetTemplatePg(t.db, null, "booking_confirmation")).toBe(true);
    expect(await listTemplatesPg(t.db, null)).toEqual([]);
  });

  it("a visit under 24 hours away gets the confirmation only", async () => {
    const b = await booked(1);
    await t.db.query("UPDATE inspection_booking SET scheduled_at = now() + interval '13 hours' WHERE id = $1", [b.bookingId]);
    expect(await draftBookingMessages(t.db, b.bookingId, new Date().toISOString(), env)).toBe(1);
  });
});
