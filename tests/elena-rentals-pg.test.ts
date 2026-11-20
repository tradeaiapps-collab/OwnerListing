import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addSlots, bookViewing, cancelSlot, cancelViewing, decideApplication, deskFor, endTenancy, getRepair, getRepairPhoto, getSettings, markAttendance, myRentals, ownerRepairAction,
  runDueRentals, saveSettings, startTenancy, submitApplication, submitRepair, tenantRepairAction, withdrawApplication, type RentalSender
} from "../src/server/elena-rentals-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("Elena rentals on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const NOW = new Date().toISOString();
  const hours = (base: string, h: number) => new Date(new Date(base).getTime() + h * 3600_000).toISOString();
  const outbox: { userId: string; kind: string; title: string; body: string }[] = [];
  const sender: RentalSender = { async send(userId, kind, title, body) { outbox.push({ userId, kind, title, body }); return true; } };
  const to = (id: string, kind?: string) => outbox.filter(o => o.userId === id && (!kind || o.kind === kind));
  const env = {};
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
  const GOOD_SETTINGS = { elenaOn: true, maxRentPct: 35, minHistoryMonths: 12, minReferences: 2, moveInFrom: "2026-11-01", moveInTo: "2036-12-31", autoRepairOffers: false, autoEmergency: false };

  async function rental(settings: Record<string, unknown> | null = GOOD_SETTINGS) {
    const ownerId = await addUser(t.db, "owner");
    const listingId = await addListing(t.db, ownerId, { transaction_type: "rent", status: "published", price_cents: 60000, address_text: "12 Smith St, Newtown", suburb: "Newtown", postcode: "2042" });
    if (settings) expect((await saveSettings(t.db, ownerId, listingId, settings)).ok).toBe(true);
    return { ownerId, listingId };
  }
  async function contractor(name: string, o: { verified?: boolean; suspended?: boolean } = { verified: true }) {
    const id = String((await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,'vendor','active') RETURNING id", [`${randomUUID()}@example.test`, name])).rows[0]!["id"]);
    await t.db.query("INSERT INTO contractor_page (user_id, is_public, trade_label, headline) VALUES ($1, true, 'Plumber and gas fitter', 'Local plumber') ON CONFLICT (user_id) DO UPDATE SET is_public = true, trade_label = 'Plumber and gas fitter', headline = 'Local plumber'", [id]);
    await t.db.query("INSERT INTO contractor_profile (user_id, kind, accepting_new, service_postcodes, service_suburbs) VALUES ($1,'other',true,'{2042}','{Newtown}') ON CONFLICT (user_id, kind) DO UPDATE SET accepting_new = true", [id]);
    if (o.verified) await t.db.query("INSERT INTO contractor_verification (user_id, business_name, abn, insurer, policy_number, insurance_expiry, status, reviewed_at, reviewed_by) VALUES ($1,'Biz','12345678901','Ins','P1', current_date + 200, 'verified', now(), (SELECT id FROM app_user LIMIT 1))", [id]);
    if (o.suspended) await t.db.query("INSERT INTO contractor_standing (user_id, suspended, reason) VALUES ($1, true, 'test')", [id]);
    return id;
  }
  async function applicant(listingId: string, input: Record<string, unknown> = {}) {
    const userId = await addUser(t.db, "buyer");
    const r = await submitApplication(t.db, sender, userId, listingId, input, NOW);
    expect(r.ok).toBe(true);
    return { userId, appId: r.ok ? r.value.id : "" };
  }

  it("only the owner of a rent listing can change its settings, and automatic actions need Elena switched on", async () => {
    const { ownerId, listingId } = await rental(null);
    const stranger = await addUser(t.db, "owner");
    expect((await saveSettings(t.db, stranger, listingId, GOOD_SETTINGS)).ok).toBe(false);
    const sale = await addListing(t.db, ownerId, { transaction_type: "sale" });
    expect((await saveSettings(t.db, ownerId, sale, GOOD_SETTINGS)).ok).toBe(false);
    expect((await saveSettings(t.db, ownerId, listingId, { ...GOOD_SETTINGS, elenaOn: false, autoRepairOffers: true, autoEmergency: true })).ok).toBe(true);
    expect(await getSettings(t.db, listingId)).toMatchObject({ elenaOn: false, autoRepairOffers: false, autoEmergency: false });
    expect((await saveSettings(t.db, ownerId, listingId, { ...GOOD_SETTINGS, maxRentPct: 3 })).ok).toBe(false);
    expect(await deskFor(t.db, stranger, listingId)).toBeUndefined();
  });

  it("screens applications side by side, asks for what is missing, and never decides for the owner", async () => {
    outbox.length = 0;
    const { ownerId, listingId } = await rental();
    const strong = await applicant(listingId, { weeklyIncome: 2000, rentalHistoryMonths: 30, referencesCount: 3, moveInDate: "2026-12-10" });
    const partial = await applicant(listingId, { weeklyIncome: 1900 });
    const weak = await applicant(listingId, { weeklyIncome: 900, rentalHistoryMonths: 24, referencesCount: 2, moveInDate: "2026-12-10" });
    expect(to(strong.userId, "application_received")).toHaveLength(1);
    expect(to(ownerId, "application_owner")).toHaveLength(3);
    // Elena asks the partial applicant for what is missing; the strong one is asked for nothing.
    expect(to(partial.userId, "info_request")).toHaveLength(1);
    expect(to(partial.userId, "info_request")[0]!.body).toContain("rental history");
    expect(to(strong.userId, "info_request")).toHaveLength(0);
    const desk = (await deskFor(t.db, ownerId, listingId))!;
    expect(desk.applications.map(a => a.id)).toEqual([strong.appId, partial.appId, weak.appId]);
    expect(desk.applications.map(a => a.rank)).toEqual([1, 2, 3]);
    expect(desk.applications[0]!.evaluation.headline).toBe("Meets 4 of 4 criteria.");
    expect(desk.applications[2]!.evaluation.criteria.find(c => c.key === "income")!.status).toBe("not_met");
    expect(desk.applications.every(a => a.status !== "declined")).toBe(true);
    // The ask is limited: a second update does not trigger a second ask inside two days.
    await submitApplication(t.db, sender, partial.userId, listingId, { weeklyIncome: 1900 }, NOW);
    expect(to(partial.userId, "info_request")).toHaveLength(1);
    // Only the owner decides. A stranger and the applicant cannot.
    expect((await decideApplication(t.db, sender, partial.userId, strong.appId, "approve", NOW)).ok).toBe(false);
    expect((await decideApplication(t.db, sender, await addUser(t.db, "owner"), strong.appId, "approve", NOW)).ok).toBe(false);
    expect((await decideApplication(t.db, sender, ownerId, strong.appId, "shortlist", NOW)).ok).toBe(true);
    expect((await decideApplication(t.db, sender, ownerId, weak.appId, "decline", NOW)).ok).toBe(true);
    expect(to(weak.userId, "decision_declined")[0]!.body).toBe("Hi Test, The owner of 12 Smith St, Newtown has chosen another applicant. Thanks for applying.");
    expect((await t.db.query("SELECT status FROM rental_application WHERE id = $1", [weak.appId])).rows[0]!["status"]).toBe("declined");
    // The owner's audit trail records the decision.
    expect((await t.db.query("SELECT 1 FROM audit_event WHERE aggregate_id = $1 AND event_type = 'rental_application_declined'", [weak.appId])).rows).toHaveLength(1);
  });

  it("withholds a note that names a protected attribute and still ranks without it", async () => {
    const { ownerId, listingId } = await rental();
    const a = await applicant(listingId, { weeklyIncome: 2000, rentalHistoryMonths: 30, referencesCount: 3, moveInDate: "2026-12-10", note: "We are a young family with two children" });
    const desk = (await deskFor(t.db, ownerId, listingId))!;
    expect(desk.applications[0]).toMatchObject({ id: a.appId, noteWithheld: true });
    expect(desk.applications[0]!.note).toBeUndefined();
    expect(desk.applications[0]!.evaluation.headline).toBe("Meets 4 of 4 criteria.");
  });

  it("rejects applications to your own listing, to unpublished listings, and after five a day", async () => {
    const { ownerId, listingId } = await rental();
    expect((await submitApplication(t.db, sender, ownerId, listingId, {}, NOW)).ok).toBe(false);
    const draft = await addListing(t.db, ownerId, { transaction_type: "rent", status: "draft" });
    expect((await submitApplication(t.db, sender, await addUser(t.db, "buyer"), draft, {}, NOW)).ok).toBe(false);
    const u = await addUser(t.db, "buyer");
    let last = true;
    for (let i = 0; i < 6; i++) last = (await submitApplication(t.db, sender, u, (await rental()).listingId, {}, NOW)).ok;
    expect(last).toBe(false);
  });

  it("books viewings without overbooking, reschedules, cancels, reminds and summarises", async () => {
    outbox.length = 0;
    const { ownerId, listingId } = await rental();
    const a = await applicant(listingId, { weeklyIncome: 2000, rentalHistoryMonths: 30, referencesCount: 3, moveInDate: "2026-12-10" });
    const b = await applicant(listingId, { weeklyIncome: 2000, rentalHistoryMonths: 30, referencesCount: 3, moveInDate: "2026-12-10" });
    const s1 = hours(NOW, 30), s2 = hours(NOW, 54), s3 = hours(NOW, 78);
    expect((await addSlots(t.db, sender, ownerId, listingId, { slots: [{ startsAt: hours(NOW, 0.2) }] }, NOW)).ok).toBe(false);
    expect(await addSlots(t.db, sender, ownerId, listingId, { slots: [{ startsAt: s1 }, { startsAt: s2, capacity: 2 }, { startsAt: s3 }] }, NOW)).toMatchObject({ ok: true, value: { added: 3 } });
    expect((await addSlots(t.db, sender, await addUser(t.db, "owner"), listingId, { slots: [{ startsAt: s1 }] }, NOW)).ok).toBe(false);
    // Elena offers the times to applicants who have not booked
    expect(to(a.userId, "viewing_offer")).toHaveLength(1);
    expect(to(a.userId, "viewing_offer")[0]!.body).toContain(";");
    const slots = (await deskFor(t.db, ownerId, listingId))!.slots;
    const [x1, x2] = [slots[0]!, slots[1]!];
    const first = await bookViewing(t.db, sender, a.userId, a.appId, x1.id, NOW);
    expect(first.ok).toBe(true);
    expect(to(a.userId, "viewing_confirmed")).toHaveLength(1);
    expect(to(ownerId, "viewing_confirmed_owner")).toHaveLength(1);
    // the single-place time is now full for someone else
    const full = await bookViewing(t.db, sender, b.userId, b.appId, x1.id, NOW);
    expect(full.ok).toBe(false);
    // two people can share a two-place time; a stranger cannot book on someone else's application
    expect((await bookViewing(t.db, sender, b.userId, b.appId, x2.id, NOW)).ok).toBe(true);
    expect((await bookViewing(t.db, sender, b.userId, a.appId, x2.id, NOW)).ok).toBe(false);
    // moving a booking frees the old place
    expect((await bookViewing(t.db, sender, a.userId, a.appId, x2.id, NOW)).ok).toBe(true);
    expect((await t.db.query("SELECT count(*)::int AS n FROM rental_viewing WHERE application_id = $1 AND status = 'booked'", [a.appId])).rows[0]!["n"]).toBe(1);
    expect((await bookViewing(t.db, sender, b.userId, b.appId, x1.id, NOW)).ok).toBe(true);
    // reminders: 24h then 2h, once each
    outbox.length = 0;
    const r1 = await runDueRentals(t.db, hours(NOW, 40), sender, env);
    expect(r1.reminders).toBe(1); // the +30h time is already past; the +54h time is within a day
    expect(to(a.userId, "viewing_reminder_24h")).toHaveLength(1);
    expect(await runDueRentals(t.db, hours(NOW, 41), sender, env)).toMatchObject({ reminders: 0 });
    await runDueRentals(t.db, hours(NOW, 52.5), sender, env);
    expect(to(a.userId, "viewing_reminder_2h")).toHaveLength(1);
    // one summary to the owner after each slot has finished, never twice
    expect(to(ownerId, "viewing_summary")).toHaveLength(1);
    expect((await runDueRentals(t.db, hours(NOW, 56), sender, env)).summaries).toBe(1);
    expect(await runDueRentals(t.db, hours(NOW, 57), sender, env)).toMatchObject({ summaries: 0 });
    expect(to(ownerId, "viewing_summary")).toHaveLength(2);
    expect(to(ownerId, "viewing_summary").every(m => m.body.includes("comparison position"))).toBe(true);
    // attendance can only be recorded once the viewing has started, and only by the owner
    expect((await markAttendance(t.db, ownerId, b.appId, true)).ok).toBe(false);
    await t.db.query("UPDATE rental_viewing_slot SET starts_at = now() - interval '1 hour' WHERE id = $1", [x1.id]);
    expect((await markAttendance(t.db, a.userId, b.appId, true)).ok).toBe(false);
    expect((await markAttendance(t.db, ownerId, b.appId, true)).ok).toBe(true);
    // cancelling a time tells the people booked on it
    outbox.length = 0;
    const cs = await cancelSlot(t.db, sender, ownerId, x2.id, NOW);
    expect(cs).toMatchObject({ ok: true, value: { notified: 1 } });
    expect(to(a.userId, "viewing_cancelled")).toHaveLength(1);
    expect((await cancelViewing(t.db, sender, a.userId, a.appId, NOW)).ok).toBe(false);
  });

  it("a withdrawn or declined application cannot book, and withdrawing frees the place", async () => {
    const { ownerId, listingId } = await rental();
    const a = await applicant(listingId, {});
    await addSlots(t.db, sender, ownerId, listingId, { slots: [{ startsAt: hours(NOW, 30) }] }, NOW);
    const slot = (await deskFor(t.db, ownerId, listingId))!.slots[0]!;
    expect((await bookViewing(t.db, sender, a.userId, a.appId, slot.id, NOW)).ok).toBe(true);
    expect((await withdrawApplication(t.db, a.userId, a.appId)).ok).toBe(true);
    expect((await t.db.query("SELECT count(*)::int AS n FROM rental_viewing WHERE application_id = $1 AND status = 'booked'", [a.appId])).rows[0]!["n"]).toBe(0);
    expect((await bookViewing(t.db, sender, a.userId, a.appId, slot.id, NOW)).ok).toBe(false);
  });

  async function tenancy(o: Awaited<ReturnType<typeof rental>>) {
    const a = await applicant(o.listingId, { weeklyIncome: 2000, rentalHistoryMonths: 30, referencesCount: 3, moveInDate: "2026-12-10" });
    expect((await startTenancy(t.db, sender, o.ownerId, o.listingId, { applicationId: a.appId }, NOW)).ok).toBe(false); // not approved yet
    await decideApplication(t.db, sender, o.ownerId, a.appId, "approve", NOW);
    const r = await startTenancy(t.db, sender, o.ownerId, o.listingId, { applicationId: a.appId }, NOW);
    expect(r.ok).toBe(true);
    return { tenantId: a.userId, tenancyId: r.ok ? r.value.id : "" };
  }

  it("a tenant reports a routine repair; Elena proposes a verified contractor, the owner approves, the job offer carries no price, and photos are private", async () => {
    outbox.length = 0;
    const o = await rental();
    const unverified = await contractor("Una Unverified", { verified: false });
    const suspended = await contractor("Sue Suspended", { verified: true, suspended: true });
    const good = await contractor("Gus Good");
    const { tenantId, tenancyId } = await tenancy(o);
    // a stranger without a tenancy cannot report; a bad photo is refused
    expect((await submitRepair(t.db, sender, env, await addUser(t.db, "buyer"), { tenancyId, category: "plumbing", description: "Kitchen tap drips all day" }, [], NOW)).ok).toBe(false);
    expect((await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "plumbing", description: "Kitchen tap drips all day" }, [{ bytes: new Uint8Array([1, 2, 3]) }], NOW)).ok).toBe(false);
    const r = await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "plumbing", description: "The bathroom tap is loose and wobbles" }, [{ bytes: PNG }], NOW);
    expect(r).toMatchObject({ ok: true, value: { urgency: "routine", emergencySent: false } });
    const id = r.ok ? r.value.id : "";
    expect(to(tenantId, "repair_received")).toHaveLength(1);
    expect(to(o.ownerId, "repair_owner_new")).toHaveLength(1);
    let rep = (await getRepair(t.db, id))!;
    expect(rep).toMatchObject({ status: "awaiting_owner", proposedContractorId: good });
    expect([unverified, suspended]).not.toContain(rep.proposedContractorId);
    expect(to(o.ownerId, "repair_proposal")).toHaveLength(1);
    // approval is the owner's alone
    expect((await ownerRepairAction(t.db, sender, env, tenantId, id, "approve", NOW)).ok).toBe(false);
    expect((await ownerRepairAction(t.db, sender, env, o.ownerId, id, "approve", NOW)).ok).toBe(true);
    rep = (await getRepair(t.db, id))!;
    expect(rep.status).toBe("offered");
    const job = (await t.db.query("SELECT kind, status, price_cents, offer_source, note FROM job_assignment WHERE id = $1", [rep.assignmentId])).rows[0]!;
    expect(job).toMatchObject({ kind: "other", status: "proposed", price_cents: null, offer_source: "elena" });
    expect(String(job["note"])).toContain("RR-");
    expect(to(tenantId, "repair_offered")).toHaveLength(1);
    // photos: the tenant and owner can see them; the contractor only after accepting; nobody else
    const photoId = String((await t.db.query("SELECT id FROM rental_repair_photo WHERE repair_id = $1", [id])).rows[0]!["id"]);
    expect(await getRepairPhoto(t.db, tenantId, id, photoId)).toBeDefined();
    expect(await getRepairPhoto(t.db, o.ownerId, id, photoId)).toBeDefined();
    expect(await getRepairPhoto(t.db, good, id, photoId)).toBeUndefined();
    expect(await getRepairPhoto(t.db, await addUser(t.db, "buyer"), id, photoId)).toBeUndefined();
    // the contractor accepts and agrees a time well ahead: both sides are told, the tenant gets an entry notice
    const at = hours(NOW, 72);
    await t.db.query("UPDATE job_assignment SET status = 'approved', scheduled_time = $2 WHERE id = $1", [rep.assignmentId, at]);
    expect(await getRepairPhoto(t.db, good, id, photoId)).toBeDefined();
    outbox.length = 0;
    await t.db.query("UPDATE rental_repair SET next_action_at = $2 WHERE id = $1", [id, NOW]);
    await runDueRentals(t.db, hours(NOW, 1), sender, env);
    rep = (await getRepair(t.db, id))!;
    expect(rep.status).toBe("scheduled");
    expect(to(tenantId, "repair_scheduled")).toHaveLength(1);
    expect(to(o.ownerId, "repair_scheduled")).toHaveLength(1);
    expect(to(tenantId, "repair_notice")).toHaveLength(1);
    expect(rep.noticeSentAt).toBeDefined();
    // after the visit, Elena checks with the tenant, and "not fixed" reopens it for the owner
    outbox.length = 0;
    await t.db.query("UPDATE rental_repair SET next_action_at = $2 WHERE id = $1", [id, hours(at, 3)]);
    await runDueRentals(t.db, hours(at, 3.1), sender, env);
    await t.db.query("UPDATE rental_repair SET next_action_at = $2 WHERE id = $1", [id, hours(at, 3)]);
    await runDueRentals(t.db, hours(at, 3.2), sender, env);
    expect((await getRepair(t.db, id))!.status).toBe("check_in");
    expect(to(tenantId, "repair_check")).toHaveLength(1);
    expect((await tenantRepairAction(t.db, sender, env, o.ownerId, id, "fixed", NOW)).ok).toBe(false);
    expect((await tenantRepairAction(t.db, sender, env, tenantId, id, "not_fixed", NOW)).ok).toBe(true);
    expect((await getRepair(t.db, id))!.status).toBe("awaiting_owner");
    expect(to(o.ownerId, "repair_reopened")).toHaveLength(1);
    expect((await tenantRepairAction(t.db, sender, env, tenantId, id, "fixed", NOW)).ok).toBe(true);
    expect((await getRepair(t.db, id))!.status).toBe("closed");
    expect(to(tenantId, "repair_closed")).toHaveLength(1);
    // the tenancy ends: no more reports
    expect((await endTenancy(t.db, o.ownerId, tenancyId)).ok).toBe(true);
    expect((await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "plumbing", description: "The bathroom tap is loose again" }, [], NOW)).ok).toBe(false);
  });

  it("sends the job offer itself only when the owner switched automatic offers on, and never for an emergency", async () => {
    outbox.length = 0;
    const o = await rental({ ...GOOD_SETTINGS, autoRepairOffers: true });
    await contractor("Gus Good");
    const { tenantId, tenancyId } = await tenancy(o);
    const r = await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "appliance", description: "The washing machine will not drain" }, [], NOW);
    const id = r.ok ? r.value.id : "";
    expect((await getRepair(t.db, id))!.status).toBe("offered");
    expect((await t.db.query("SELECT price_cents, offer_source FROM job_assignment WHERE listing_id = $1 AND kind = 'other'", [o.listingId])).rows[0]).toMatchObject({ price_cents: null, offer_source: "elena" });
    expect(to(o.ownerId, "repair_offered")).toHaveLength(1);
    const e = await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "plumbing", description: "A pipe has burst and water is pouring everywhere" }, [], NOW);
    expect(e).toMatchObject({ ok: true, value: { urgency: "emergency", emergencySent: false } });
    expect((await t.db.query("SELECT count(*)::int AS n FROM job_assignment WHERE listing_id = $1", [o.listingId])).rows[0]!["n"]).toBe(1);
  });

  it("an emergency tells the tenant to act first, alerts the owner at once, and goes to emergency contractors only on the owner's say-so", async () => {
    outbox.length = 0;
    const o = await rental();
    const { tenantId, tenancyId } = await tenancy(o);
    const r = await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "gas", description: "I can smell gas near the stove" }, [], NOW);
    expect(r).toMatchObject({ ok: true, value: { urgency: "emergency", emergencySent: false } });
    const id = r.ok ? r.value.id : "";
    expect(to(tenantId, "repair_received")[0]!.body).toContain("Leave the property");
    expect(to(o.ownerId, "repair_emergency_owner")).toHaveLength(1);
    expect((await t.db.query("SELECT 1 FROM emergency_request WHERE requester_user_id = $1", [o.ownerId])).rows).toHaveLength(0);
    // the owner presses the button
    expect((await ownerRepairAction(t.db, sender, env, tenantId, id, "send_emergency", NOW)).ok).toBe(false);
    expect((await ownerRepairAction(t.db, sender, env, o.ownerId, id, "send_emergency", NOW)).ok).toBe(true);
    const rep = (await getRepair(t.db, id))!;
    expect(rep.status).toBe("emergency");
    expect(rep.emergencyRequestId).toBeDefined();
    expect((await t.db.query("SELECT property_kind FROM emergency_request WHERE id = $1", [rep.emergencyRequestId])).rows[0]!["property_kind"]).toBe("rental");
    expect((await ownerRepairAction(t.db, sender, env, o.ownerId, id, "send_emergency", NOW)).ok).toBe(false);
    // half an hour with nobody accepting: both sides are told once
    outbox.length = 0;
    await t.db.query("UPDATE rental_repair SET next_action_at = $2 WHERE id = $1", [id, NOW]);
    await t.db.query("UPDATE emergency_request SET created_at = now() - interval '40 minutes' WHERE id = $1", [rep.emergencyRequestId]);
    await runDueRentals(t.db, new Date().toISOString(), sender, env);
    expect(to(o.ownerId, "repair_emergency_quiet")).toHaveLength(1);
    expect(to(tenantId, "repair_emergency_quiet")).toHaveLength(1);
  });

  it("sends the emergency itself only when the owner turned that on", async () => {
    const o = await rental({ ...GOOD_SETTINGS, autoEmergency: true });
    const { tenantId, tenancyId } = await tenancy(o);
    const r = await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "electrical", description: "There are sparks coming from the power point" }, [], NOW);
    expect(r).toMatchObject({ ok: true, value: { urgency: "emergency", emergencySent: true } });
    expect((await getRepair(t.db, r.ok ? r.value.id : ""))!.status).toBe("emergency");
    expect((await t.db.query("SELECT 1 FROM emergency_request WHERE requester_user_id = $1", [o.ownerId])).rows).toHaveLength(1);
  });

  it("a visit under 24 hours away waits for the tenant's yes; and Elena hands back after three unanswered nudges", async () => {
    outbox.length = 0;
    const o = await rental();
    await contractor("Gus Good");
    const { tenantId, tenancyId } = await tenancy(o);
    const r = await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "plumbing", description: "The bathroom tap is loose and wobbles" }, [], NOW);
    const id = r.ok ? r.value.id : "";
    await ownerRepairAction(t.db, sender, env, o.ownerId, id, "approve", NOW);
    const rep = (await getRepair(t.db, id))!;
    const soon = hours(NOW, 6);
    await t.db.query("UPDATE job_assignment SET status = 'approved', scheduled_time = $2 WHERE id = $1", [rep.assignmentId, soon]);
    await t.db.query("UPDATE rental_repair SET next_action_at = $2 WHERE id = $1", [id, NOW]);
    outbox.length = 0;
    await runDueRentals(t.db, hours(NOW, 0.5), sender, env);
    expect(to(tenantId, "repair_short_notice")).toHaveLength(1);
    expect(to(tenantId, "repair_notice")).toHaveLength(0);
    expect((await getRepair(t.db, id))!.noticeSentAt).toBeUndefined();
    expect((await tenantRepairAction(t.db, sender, env, o.ownerId, id, "consent_visit", NOW)).ok).toBe(false);
    expect((await tenantRepairAction(t.db, sender, env, tenantId, id, "consent_visit", NOW)).ok).toBe(true);
    expect(to(tenantId, "repair_notice")).toHaveLength(1);
    // nudges: three, then stop
    const o2 = await rental();
    const t2 = await tenancy(o2);
    const r2 = await submitRepair(t.db, sender, env, t2.tenantId, { tenancyId: t2.tenancyId, category: "other", description: "A cupboard door hinge is loose" }, [], NOW);
    const id2 = r2.ok ? r2.value.id : "";
    outbox.length = 0;
    for (let i = 1; i <= 4; i++) {
      await t.db.query("UPDATE rental_repair SET next_action_at = $2 WHERE id = $1", [id2, NOW]);
      await runDueRentals(t.db, hours(NOW, i * 30), sender, env);
    }
    expect(to(o2.ownerId, "repair_chase_owner")).toHaveLength(3);
    expect(to(o2.ownerId, "repair_needs_owner")).toHaveLength(1);
    expect((await getRepair(t.db, id2))!.status).toBe("needs_owner");
    expect((await ownerRepairAction(t.db, sender, env, o2.ownerId, id2, "reopen", NOW)).ok).toBe(true);
  });

  it("does nothing automatic for a listing where Elena is off, and shows each person only their own rentals", async () => {
    const o = await rental({ ...GOOD_SETTINGS, elenaOn: false });
    const a = await applicant(o.listingId, {});
    expect(to(a.userId, "info_request").length).toBe(0);
    const { tenantId, tenancyId } = await tenancy(o);
    const r = await submitRepair(t.db, sender, env, tenantId, { tenancyId, category: "other", description: "A cupboard door hinge is loose" }, [], NOW);
    expect((await t.db.query("SELECT next_action_at FROM rental_repair WHERE id = $1", [r.ok ? r.value.id : ""])).rows[0]!["next_action_at"]).toBeNull();
    const mine = await myRentals(t.db, tenantId, NOW);
    expect(mine.tenancies).toHaveLength(1);
    expect(mine.repairs).toHaveLength(1);
    expect((await myRentals(t.db, await addUser(t.db, "buyer"), NOW))).toEqual({ applications: [], tenancies: [], repairs: [] });
    // the log of what Elena sent cannot be edited or deleted
    await expect(t.db.query("DELETE FROM rental_message")).rejects.toThrow();
  });
});
