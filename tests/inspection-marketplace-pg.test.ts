import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptBooking, applyAsInspector, cancelBooking, passBooking, requestInspection, reviewInspector } from "../src/domain/inspection-marketplace";
import { getReport } from "../src/domain/inspection";
import type { Actor } from "../src/domain/listing-service";
import { createPgInspectionRepository } from "../src/server/inspection-db";
import { createPgBookingRepository } from "../src/server/inspection-marketplace-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("inspection marketplace on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const slot = (days: number) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(1, 0, 0, 0); return d.toISOString(); };
  const user = async (type: string) =>
    String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,$3,'active') RETURNING id", [`${randomUUID()}@example.test`, `Test ${type}`, type])).rows[0]!["id"]);
  const verify = (id: string) => t.db.query("INSERT INTO buyer_verification (user_id, email_verified_at, phone_verified_at, id_verified_at) VALUES ($1, now(), now(), now())", [id]);
  let r!: ReturnType<typeof createPgBookingRepository>;
  beforeAll(() => { r = createPgBookingRepository(t.db); });
  const audits = async (type: string) => Number((await t.db.query("SELECT count(*) AS n FROM audit_event WHERE event_type = $1", [type])).rows[0]!["n"]);

  async function world() {
    const ownerId = await addUser(t.db, "owner"), buyerId = await user("buyer");
    await verify(buyerId);
    const listingId = await addListing(t.db, ownerId, { status: "published", jurisdiction: "NSW", title: "Cottage" });
    return { owner: { userId: ownerId, userType: "owner" } as Actor, buyer: { userId: buyerId, userType: "buyer" } as Actor, listingId };
  }
  const inspector = async (states?: string[]) => {
    const id = await user("vendor");
    const a: Actor = { userId: id, userType: "vendor" };
    expect((await applyAsInspector(r, a, { businessName: "Sound Checks", jurisdictions: states ?? ["NSW"] }, ids)).ok).toBe(true);
    expect((await reviewInspector(r, await addUser(t.db, "admin"), id, "approved", "", ids)).ok).toBe(true);
    return a;
  };

  it("books, is seen by an approved inspector in the state, accepted once, and becomes an inspection the buyer can later see", async () => {
    const w = await world();
    const req = await requestInspection(r, w.buyer, w.listingId, { slots: [slot(3), slot(4)], notes: "Check the roof" }, ids);
    if (!req.ok) throw new Error(req.message);
    const bookingId = req.value.id;
    expect((await r.bookingsForBuyer(w.buyer.userId))[0]).toMatchObject({ status: "pending_inspector_response", notes: "Check the roof" });
    expect((await requestInspection(r, w.buyer, w.listingId, { slots: [slot(5)] }, ids))).toMatchObject({ ok: false, code: "conflict" });

    const nsw = await inspector(), vic = await inspector(["VIC"]), second = await inspector();
    expect((await r.openRequests(nsw.userId)).map(x => x.id)).toContain(bookingId);
    expect((await r.openRequests(vic.userId)).map(x => x.id)).not.toContain(bookingId);
    expect(JSON.stringify(await r.openRequests(nsw.userId))).not.toContain(w.buyer.userId);

    // Wrong state, a time the buyer did not offer, and the buyer's own account all fail with the same answer.
    expect(await acceptBooking(r, vic, bookingId, slot(3), ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await acceptBooking(r, nsw, bookingId, slot(9), ids)).toMatchObject({ ok: false, code: "conflict" });
    const ok = await acceptBooking(r, nsw, bookingId, slot(3), ids);
    if (!ok.ok) throw new Error(ok.message);
    expect(await acceptBooking(r, second, bookingId, slot(3), ids)).toMatchObject({ ok: false, code: "conflict" });

    const [b] = await r.bookingsForBuyer(w.buyer.userId);
    expect(b).toMatchObject({ status: "scheduled", inspectionId: ok.value.inspectionId, scheduledAt: slot(3) });
    const insp = await t.db.query("SELECT status, requested_by, inspector_user_id, inspection_type FROM inspection WHERE id = $1", [ok.value.inspectionId]);
    expect(insp.rows[0]).toMatchObject({ status: "accepted", requested_by: w.buyer.userId, inspector_user_id: nsw.userId, inspection_type: "pre_purchase" });
    expect((await r.openRequests(second.userId)).map(x => x.id)).not.toContain(bookingId);
    expect((await r.bookingsForInspector(nsw.userId))).toHaveLength(1);

    // The seller manages the inspection; the report workflow is the existing one.
    expect((await getReport(createPgInspectionRepository(t.db), w.owner, ok.value.inspectionId)).ok).toBe(true);
    expect(await audits("inspection_booking.requested")).toBeGreaterThan(0);
    expect(await audits("inspection_booking.accepted")).toBeGreaterThan(0);

    // Completing the inspection flips the buyer's status, and a finished one cannot be cancelled.
    await t.db.query("UPDATE inspection SET status = 'completed', completed_at = now() WHERE id = $1", [ok.value.inspectionId]);
    expect((await r.bookingsForBuyer(w.buyer.userId))[0]!.status).toBe("completed");
    expect(await cancelBooking(r, w.buyer, bookingId, ids)).toMatchObject({ ok: false });
  });

  it("needs verification, a published listing the buyer does not own, and an approved inspector", async () => {
    const w = await world();
    const unverified: Actor = { userId: await user("buyer"), userType: "buyer" };
    expect(await requestInspection(r, unverified, w.listingId, { slots: [slot(3)] }, ids)).toMatchObject({ code: "forbidden" });
    const draft = await addListing(t.db, w.owner.userId, { status: "draft" });
    expect(await requestInspection(r, w.buyer, draft, { slots: [slot(3)] }, ids)).toMatchObject({ code: "not_found" });
    await verify(w.owner.userId);
    expect(await requestInspection(r, w.owner, w.listingId, { slots: [slot(3)] }, ids)).toMatchObject({ code: "not_found" });

    const req = await requestInspection(r, w.buyer, w.listingId, { slots: [slot(3)] }, ids);
    if (!req.ok) throw new Error(req.message);
    const pending = await user("vendor");
    await applyAsInspector(r, { userId: pending, userType: "vendor" }, { businessName: "Not yet", jurisdictions: ["NSW"] }, ids);
    expect(await acceptBooking(r, { userId: pending, userType: "vendor" }, req.value.id, slot(3), ids)).toMatchObject({ ok: false });
    expect(await r.openRequests(pending)).toHaveLength(0);
    // The listing owner cannot take the job even as an approved inspector.
    const ownerInspector = await user("vendor");
    await t.db.query("UPDATE property_listing SET owner_user_id = $1 WHERE id = $2", [ownerInspector, w.listingId]);
    await applyAsInspector(r, { userId: ownerInspector, userType: "vendor" }, { businessName: "Self", jurisdictions: ["NSW"] }, ids);
    await reviewInspector(r, await addUser(t.db, "admin"), ownerInspector, "approved", "", ids);
    expect(await acceptBooking(r, { userId: ownerInspector, userType: "vendor" }, req.value.id, slot(3), ids)).toMatchObject({ ok: false });
  });

  it("pass hides a request from that inspector only; the buyer can cancel, which cancels the accepted inspection too", async () => {
    const w = await world();
    const req = await requestInspection(r, w.buyer, w.listingId, { slots: [slot(3)] }, ids);
    if (!req.ok) throw new Error(req.message);
    const a = await inspector(), b = await inspector();
    expect((await passBooking(r, a, req.value.id, ids)).ok).toBe(true);
    expect((await r.openRequests(a.userId)).map(x => x.id)).not.toContain(req.value.id);
    expect((await r.openRequests(b.userId)).map(x => x.id)).toContain(req.value.id);
    const acc = await acceptBooking(r, b, req.value.id, slot(3), ids);
    if (!acc.ok) throw new Error(acc.message);
    expect((await cancelBooking(r, w.buyer, req.value.id, ids)).ok).toBe(true);
    expect((await t.db.query("SELECT status FROM inspection WHERE id = $1", [acc.value.inspectionId])).rows[0]!["status"]).toBe("cancelled");
    expect((await r.bookingsForBuyer(w.buyer.userId))[0]!.status).toBe("cancelled");
    // Someone else's request cannot be cancelled.
    expect(await cancelBooking(r, w.owner, req.value.id, ids)).toMatchObject({ ok: false });
    // A cancelled request frees the buyer to ask again.
    expect((await requestInspection(r, w.buyer, w.listingId, { slots: [slot(6)] }, ids)).ok).toBe(true);
  });

  it("staff decisions follow the allowed moves and are audited; booking rows are never deleted", async () => {
    const id = await user("agent");
    await applyAsInspector(r, { userId: id, userType: "agent" }, { businessName: "Agent Checks", jurisdictions: ["QLD"] }, ids);
    const staff = await addUser(t.db, "admin");
    expect(await reviewInspector(r, staff, id, "suspended", "x", ids)).toMatchObject({ code: "conflict" });
    expect((await reviewInspector(r, staff, id, "rejected", "Licence not found", ids)).ok).toBe(true);
    expect((await r.profile(id))).toMatchObject({ status: "rejected", reviewNote: "Licence not found" });
    // Re-applying puts it back to pending.
    await applyAsInspector(r, { userId: id, userType: "agent" }, { businessName: "Agent Checks", licenceRef: "L-1", jurisdictions: ["QLD"] }, ids);
    expect((await r.profile(id))?.status).toBe("pending");
    expect((await reviewInspector(r, staff, id, "approved", "", ids)).ok).toBe(true);
    expect((await reviewInspector(r, staff, id, "suspended", "Complaint upheld", ids)).ok).toBe(true);
    expect((await r.listProfiles("suspended")).map(p => p.userId)).toContain(id);
    expect(await audits("inspector.suspended")).toBe(1);
    await expect(t.db.query("DELETE FROM inspection_booking")).rejects.toThrow(/permanent record/);
    expect((await r.listBookings()).length).toBeGreaterThan(0);
  });
});
