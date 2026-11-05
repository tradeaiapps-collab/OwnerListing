import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ObjectStoragePort } from "../src/adapters/object-storage";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";
import {
  addFinding, approveSummary, generateSummary, getReport, listInspections, respondToInspection, revokeShare, scheduleInspection, shareReport, updateFollowup
} from "../src/domain/inspection";
import { readInspectionPhoto, uploadInspectionPhoto } from "../src/domain/inspection-photo";
import type { Actor } from "../src/domain/listing-service";
import { createPgInspectionPhotoStore, createPgInspectionRepository } from "../src/server/inspection-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";
import { jpeg, has } from "./helpers/image-fixtures";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("inspection workflow on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const ids = { newId: () => randomUUID(), now: () => new Date().toISOString() };
  const user = async (type: string, email?: string) => {
    const r = await t.db.query("INSERT INTO app_user (email, display_name, user_type, status) VALUES ($1,$2,$3,'active') RETURNING id", [email ?? `${randomUUID()}@example.test`, `Test ${type}`, type]);
    return String(r.rows[0]!["id"]);
  };
  const soon = () => new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const setup = async () => {
    const ownerId = await addUser(t.db, "owner");
    const inspectorId = await user("vendor");
    const buyerId = await user("buyer", `buyer-${randomUUID()}@example.test`);
    const strangerId = await user("buyer");
    const listingId = await addListing(t.db, ownerId, { title: "Cottage" });
    return {
      owner: { userId: ownerId, userType: "owner" } as Actor, inspector: { userId: inspectorId, userType: "vendor" } as Actor,
      buyer: { userId: buyerId, userType: "buyer" } as Actor, stranger: { userId: strangerId, userType: "buyer" } as Actor, listingId, repo: createPgInspectionRepository(t.db)
    };
  };
  const audits = async (eventType: string) =>
    Number((await t.db.query("SELECT count(*) AS n FROM audit_event WHERE event_type = $1 AND aggregate_type = 'inspection'", [eventType])).rows[0]!["n"]);

  it("books, accepts, records findings, completes, shares, and tracks follow-ups with an audit row per step", async () => {
    const { owner, inspector, buyer, stranger, listingId, repo } = await setup();
    const sched = await scheduleInspection(repo, owner, listingId, { type: "building", scheduledAt: soon(), notes: "Side gate code 1234", userId: inspector.userId }, ids);
    if (!sched.ok) throw new Error(JSON.stringify(sched));
    const id = sched.value.id;

    // The stranger and a not-yet-shared buyer cannot see it; findings need acceptance first.
    expect((await getReport(repo, stranger, id)).ok).toBe(false);
    expect(await addFinding(repo, inspector, id, { area: "Roof", title: "Cracked tiles", severity: "moderate" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await respondToInspection(repo, owner, id, { action: "accept" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await respondToInspection(repo, inspector, id, { action: "accept" }, ids)).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(await respondToInspection(repo, inspector, id, { action: "complete" }, ids)).toMatchObject({ ok: false, code: "invalid" }); // no findings yet

    const crit = await addFinding(repo, inspector, id, { area: "Switchboard", title: "Exposed wiring behind the panel", detail: "Live wire, no safety switch.", severity: "critical" }, ids);
    const mod = await addFinding(repo, inspector, id, { area: "Bathroom", title: "Possible mould on ceiling", severity: "minor" }, ids);
    const info = await addFinding(repo, inspector, id, { area: "Garage", title: "Roller door works", severity: "info" }, ids);
    if (!crit.ok || !mod.ok || !info.ok) throw new Error("findings");
    expect(info.value.followupStatus).toBe("none");
    expect(await addFinding(repo, owner, id, { area: "x", title: "y", severity: "minor" }, ids)).toMatchObject({ ok: false, code: "forbidden" });

    expect(await respondToInspection(repo, inspector, id, { action: "complete" }, ids)).toMatchObject({ ok: true, value: { status: "completed" } });
    expect(await addFinding(repo, inspector, id, { area: "Roof", title: "Late", severity: "minor" }, ids)).toMatchObject({ ok: false, code: "conflict" });

    // Follow-ups: manager only, info findings have none.
    expect(await updateFollowup(repo, inspector, id, crit.value.id, { status: "resolved" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateFollowup(repo, owner, id, info.value.id, { status: "open" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await updateFollowup(repo, owner, id, crit.value.id, { status: "in_progress", note: "Electrician booked Friday" }, ids)).toMatchObject({ ok: true });
    const report = await getReport(repo, owner, id);
    if (!report.ok) throw new Error("report");
    expect(report.value).toMatchObject({ role: "manager", openFollowUps: 2, counts: { critical: 1, minor: 1, info: 1 } });
    expect(report.value.flags.map(f => [f.findingId, f.reason])).toEqual([[crit.value.id, "severity"], [mod.value.id, "wording"]]);

    // Sharing: completed only, by manager, then the buyer sees it; revoke ends access.
    expect(await shareReport(repo, inspector, id, { userId: buyer.userId }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await shareReport(repo, owner, id, { userId: buyer.userId }, ids)).toMatchObject({ ok: true });
    expect(await shareReport(repo, owner, id, { userId: buyer.userId }, ids)).toMatchObject({ ok: false, code: "conflict" });
    const asBuyer = await getReport(repo, buyer, id);
    expect(asBuyer).toMatchObject({ ok: true, value: { role: "viewer" } });
    if (asBuyer.ok) expect(asBuyer.value.shares).toBeUndefined();
    expect(await updateFollowup(repo, buyer, id, crit.value.id, { status: "resolved" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await listInspections(repo, buyer))).toMatchObject({ ok: true, value: [{ id, role: "viewer" }] });
    const shareId = (await repo.shares(id))[0]!.id;
    expect(await revokeShare(repo, owner, id, shareId, ids)).toMatchObject({ ok: true });
    expect((await getReport(repo, buyer, id)).ok).toBe(false);
    expect((await listInspections(repo, buyer))).toMatchObject({ ok: true, value: [] });

    for (const ev of ["inspection.invited", "inspection.accepted", "inspection.finding_added", "inspection.completed", "inspection.followup_updated", "inspection.shared", "inspection.share_revoked"]) {
      expect(await audits(ev), ev).toBeGreaterThan(0);
    }
    // The database refuses edits and deletes of the record.
    await expect(t.db.query("UPDATE inspection_finding SET severity = 'info' WHERE id = $1", [crit.value.id])).rejects.toThrow(/cannot be edited/);
    await expect(t.db.query("DELETE FROM inspection_finding WHERE id = $1", [crit.value.id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM inspection WHERE id = $1", [id])).rejects.toThrow(/permanent record/);
    await expect(t.db.query("DELETE FROM inspection_share WHERE id = $1", [shareId])).rejects.toThrow(/permanent record/);
  });

  it("only the listing's owner or full-scope appointed agent manages; others cannot book or see it", async () => {
    const { owner, inspector, stranger, listingId, repo } = await setup();
    expect(await scheduleInspection(repo, stranger, listingId, { type: "pest", scheduledAt: soon(), userId: inspector.userId }, ids)).toMatchObject({ ok: false, code: "not_found" });
    // An agent with enquiry-only scope cannot; with full scope they can; after revoke they cannot.
    const agentId = await addUser(t.db, "agent");
    const agent: Actor = { userId: agentId, userType: "agent" };
    const appt = await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by, scope) VALUES ($1,$2,$3,'enquiries_and_offers') RETURNING id", [listingId, agentId, owner.userId]);
    expect(await scheduleInspection(repo, agent, listingId, { type: "pest", scheduledAt: soon(), userId: inspector.userId }, ids)).toMatchObject({ ok: false });
    await t.db.query("UPDATE listing_agent_appointment SET scope = 'full' WHERE id = $1", [appt.rows[0]!["id"]]);
    const booked = await scheduleInspection(repo, agent, listingId, { type: "pest", scheduledAt: soon(), userId: inspector.userId }, ids);
    expect(booked).toMatchObject({ ok: true });
    // Duplicate open booking of the same type with the same inspector conflicts.
    expect(await scheduleInspection(repo, owner, listingId, { type: "pest", scheduledAt: soon(), userId: inspector.userId }, ids)).toMatchObject({ ok: false, code: "conflict" });
    // Inspector cannot be the owner; past dates and unknown people are refused.
    expect(await scheduleInspection(repo, agent, listingId, { type: "building", scheduledAt: soon(), userId: owner.userId }, ids)).toMatchObject({ ok: false });
    expect(await scheduleInspection(repo, owner, listingId, { type: "building", scheduledAt: "2020-01-01T00:00:00Z", userId: inspector.userId }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await scheduleInspection(repo, owner, listingId, { type: "building", scheduledAt: soon(), email: "nobody@example.test" }, ids)).toMatchObject({ ok: false, code: "invalid" });
    if (!booked.ok) throw new Error("x");
    await t.db.query("UPDATE listing_agent_appointment SET revoked_at = now() WHERE id = $1", [appt.rows[0]!["id"]]);
    expect((await getReport(repo, agent, booked.value.id)).ok).toBe(false);
    // The owner still manages and can reschedule (goes back to invited) and cancel.
    expect(await respondToInspection(repo, inspector, booked.value.id, { action: "accept" }, ids)).toMatchObject({ ok: true });
    expect(await respondToInspection(repo, owner, booked.value.id, { action: "reschedule", scheduledAt: soon() }, ids)).toMatchObject({ ok: true, value: { status: "invited" } });
    expect(await respondToInspection(repo, inspector, booked.value.id, { action: "cancel" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await respondToInspection(repo, owner, booked.value.id, { action: "cancel" }, ids)).toMatchObject({ ok: true, value: { status: "cancelled" } });
  });

  it("two simultaneous accepts: exactly one wins", async () => {
    const { owner, inspector, listingId, repo } = await setup();
    const s = await scheduleInspection(repo, owner, listingId, { type: "building", scheduledAt: soon(), userId: inspector.userId }, ids);
    if (!s.ok) throw new Error("x");
    const r = await Promise.all([respondToInspection(repo, inspector, s.value.id, { action: "accept" }, ids), respondToInspection(repo, inspector, s.value.id, { action: "decline" }, ids)]);
    expect(r.filter(x => x.ok)).toHaveLength(1);
  });

  const fakeEngine = (reply: string): AiEnginePort => ({ ...rulesOnlyEngine, info: () => ({ id: "t", kind: "self_hosted", version: "1" }), generate: async () => reply });
  const completedWith = async (severities: ("critical" | "minor")[]) => {
    const s = await setup();
    const b = await scheduleInspection(s.repo, s.owner, s.listingId, { type: "building", scheduledAt: soon(), userId: s.inspector.userId }, ids);
    if (!b.ok) throw new Error("x");
    await respondToInspection(s.repo, s.inspector, b.value.id, { action: "accept" }, ids);
    for (const sev of severities) await addFinding(s.repo, s.inspector, b.value.id, { area: "Roof", title: `${sev} issue`, severity: sev }, ids);
    return { ...s, id: b.value.id };
  };

  it("Elena's summary: AI text is kept as a draft, unsafe AI text falls back to rules, and viewers see it only once approved", async () => {
    const s = await completedWith(["critical", "minor"]);
    const good = await generateSummary(s.repo, fakeEngine("The roof has one critical issue that should be followed up with a licensed tradesperson."), s.inspector, s.id, ids);
    expect(good).toMatchObject({ ok: true, value: { source: "ai" } });
    if (good.ok) expect(good.value.text).toContain("AI suggestion, check before publishing");
    for (const bad of ["Call me on 0412 345 678 for details", "The house is safe and fit to buy.", "See https://example.com"]) {
      const r = await generateSummary(s.repo, fakeEngine(bad), s.inspector, s.id, ids);
      expect(r).toMatchObject({ ok: true, value: { source: "rules" } });
    }
    expect(await generateSummary(s.repo, rulesOnlyEngine, s.owner, s.id, ids)).toMatchObject({ ok: true, value: { source: "rules" } });
    expect(await generateSummary(s.repo, rulesOnlyEngine, s.stranger, s.id, ids)).toMatchObject({ ok: false, code: "not_found" });
    await respondToInspection(s.repo, s.inspector, s.id, { action: "complete" }, ids);
    await shareReport(s.repo, s.owner, s.id, { userId: s.buyer.userId }, ids);
    const before = await getReport(s.repo, s.buyer, s.id);
    expect(before.ok && before.value.inspection.summary).toBeUndefined();
    expect(await approveSummary(s.repo, s.buyer, s.id, ids)).toMatchObject({ ok: false });
    expect(await approveSummary(s.repo, s.owner, s.id, ids)).toMatchObject({ ok: true });
    const after = await getReport(s.repo, s.buyer, s.id);
    expect(after.ok && after.value.inspection.summary?.approved).toBe(true);
    // Regenerating clears the approval.
    await generateSummary(s.repo, rulesOnlyEngine, s.owner, s.id, ids);
    const again = await getReport(s.repo, s.buyer, s.id);
    expect(again.ok && again.value.inspection.summary).toBeUndefined();
  });

  it("photos: inspector uploads (metadata stripped), viewers read them, others cannot, limits hold", async () => {
    const s = await completedWith(["critical"]);
    const store = createPgInspectionPhotoStore(t.db);
    const files = new Map<string, Uint8Array>();
    const storage: ObjectStoragePort = { configured: true, put: async (k, b) => { files.set(k, b); }, get: async k => files.get(k)! };
    const ports = { storage, scanner: { configured: true, scan: async () => "clean" as const } };
    const finding = (await s.repo.findings(s.id))[0]!;
    const img = jpeg({ width: 800, height: 600, orientation: 1 });
    const up = await uploadInspectionPhoto(s.repo, store, ports, s.inspector, s.id, { declaredMime: "image/jpeg", bytes: img, findingId: finding.id }, ids);
    if (!up.ok) throw new Error(JSON.stringify(up));
    expect([...files.values()].some(b => has(b, "GPS-LAT"))).toBe(false);
    expect(await uploadInspectionPhoto(s.repo, store, ports, s.owner, s.id, { declaredMime: "image/jpeg", bytes: img }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await uploadInspectionPhoto(s.repo, store, ports, s.inspector, s.id, { declaredMime: "image/png", bytes: img }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await uploadInspectionPhoto(s.repo, store, ports, s.inspector, s.id, { declaredMime: "image/jpeg", bytes: img, findingId: randomUUID() }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await uploadInspectionPhoto(s.repo, store, { ...ports, scanner: { configured: true, scan: async () => "infected" as const } }, s.inspector, s.id, { declaredMime: "image/jpeg", bytes: img }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await uploadInspectionPhoto(s.repo, store, { ...ports, storage: { ...storage, configured: false } }, s.inspector, s.id, { declaredMime: "image/jpeg", bytes: img }, ids)).toMatchObject({ ok: false, code: "unavailable" });
    for (let n = 1; n < 6; n++) await uploadInspectionPhoto(s.repo, store, ports, s.inspector, s.id, { declaredMime: "image/jpeg", bytes: img, findingId: finding.id }, ids);
    expect(await uploadInspectionPhoto(s.repo, store, ports, s.inspector, s.id, { declaredMime: "image/jpeg", bytes: img, findingId: finding.id }, ids)).toMatchObject({ ok: false, code: "conflict" });

    expect(await readInspectionPhoto(s.repo, store, storage, s.owner, s.id, up.value.id)).toMatchObject({ ok: true });
    expect(await readInspectionPhoto(s.repo, store, storage, s.stranger, s.id, up.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await readInspectionPhoto(s.repo, store, storage, s.buyer, s.id, up.value.id)).toMatchObject({ ok: false, code: "not_found" });
    await respondToInspection(s.repo, s.inspector, s.id, { action: "complete" }, ids);
    await shareReport(s.repo, s.owner, s.id, { userId: s.buyer.userId }, ids);
    expect(await readInspectionPhoto(s.repo, store, storage, s.buyer, s.id, up.value.id)).toMatchObject({ ok: true });
    expect(await uploadInspectionPhoto(s.repo, store, ports, s.inspector, s.id, { declaredMime: "image/jpeg", bytes: img }, ids)).toMatchObject({ ok: false, code: "conflict" });
    await expect(t.db.query("DELETE FROM inspection_photo WHERE id = $1", [up.value.id])).rejects.toThrow(/permanent record/);
  });
});
