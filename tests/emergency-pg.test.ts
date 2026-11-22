import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEmergencyProfile, type EmergencyProfile } from "../src/domain/emergency";
import { candidatesPg, getProfilesPg, listRequestsPg, saveProfilePg } from "../src/server/emergency-db";
import { cancelRequest, replyToRequest, submitUrgentRequest } from "../src/server/emergency-dispatch";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL: accepting is one guarded statement, so its WHERE clause is the rule (first accept wins, only a contractor who was asked).
const NOW = "2026-11-20T10:00:00.000Z"; // Friday 20:00 in Brisbane
const body = (o: Record<string, unknown> = {}) => ({ trade: "plumber", enabled: true, timeZone: "Australia/Brisbane", allHours: true, windows: [], callOutCents: 18000, contactPhone: "0412345678", serviceSuburbs: ["Paddington"], servicePostcodes: ["4064"], ...o });
const prof = (o: Record<string, unknown> = {}): EmergencyProfile => { const r = parseEmergencyProfile(body(o)); if (!r.ok) throw new Error(r.message); return r.value; };

describe.skipIf(!DATABASE_URL)("emergency contractors (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const one = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows[0]!;
  const vendor = async () => { const id = await addUser(db, "agent"); await db.query("UPDATE app_user SET user_type = 'vendor' WHERE id = $1", [id]); return id; };
  const actorOf = (userId: string, userType: "owner" | "vendor" | "buyer" = "owner") => ({ userId, userType });
  const ask = { trade: "plumber", description: "Water is coming through the kitchen ceiling", addressText: "12 Example St", suburb: "Paddington", postcode: "4064", callbackPhone: "0412000111" };

  it("saves, reloads and lists a contractor; disabled ones are not candidates", async () => {
    const a = await vendor(), b = await vendor();
    await saveProfilePg(db, a, prof()); await saveProfilePg(db, b, prof({ enabled: false }));
    expect((await getProfilesPg(db, a))[0]).toMatchObject({ trade: "plumber", enabled: true, callOutCents: 18000, serviceSuburbs: ["Paddington"] });
    await saveProfilePg(db, a, prof({ callOutCents: null, windows: [{ days: [1], start: "18:00", end: "06:00" }], allHours: false }));
    expect((await getProfilesPg(db, a))[0]).toMatchObject({ callOutCents: null, windows: [{ days: [1], start: "18:00", end: "06:00" }] });
    const ids = (await candidatesPg(db, "plumber")).map(c => c.userId);
    expect(ids).toContain(a); expect(ids).not.toContain(b);
    expect(await candidatesPg(db, "locksmith")).toEqual([]);
  });

  it("an urgent request goes to available contractors only, shows replies in one place, and the first accept wins", async () => {
    const c1 = await vendor(), c2 = await vendor(), far = await vendor(), off = await vendor();
    await saveProfilePg(db, c1, prof()); await saveProfilePg(db, c2, prof({ callOutCents: 25000 }));
    await saveProfilePg(db, far, prof({ serviceSuburbs: ["Cairns"], servicePostcodes: ["4870"] }));
    await saveProfilePg(db, off, prof({ allHours: false, windows: [{ days: [5], start: "08:00", end: "12:00" }] }));
    const owner = await addUser(db, "owner");
    const sent = await submitUrgentRequest(db, { APP_URL: "https://x.example" }, actorOf(owner), ask, NOW);
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const asked = (await db.query("SELECT contractor_user_id FROM emergency_request_contact WHERE request_id = $1", [sent.value.id])).rows.map(r => String(r["contractor_user_id"]));
    expect(asked).toEqual(expect.arrayContaining([c1, c2]));
    expect(asked).not.toContain(far); expect(asked).not.toContain(off);
    expect(sent.value.number).toBeGreaterThanOrEqual(5001);

    // A contractor who was not asked cannot accept; neither can the requester.
    expect((await replyToRequest(db, {}, actorOf(far, "vendor"), sent.value.id, { kind: "accept" })).ok).toBe(false);
    expect((await replyToRequest(db, {}, actorOf(owner), sent.value.id, { kind: "accept" })).ok).toBe(false);
    // Before anyone accepts the requester sees the asked contractors with no contact details; the contractor does not see the address.
    const before = (await listRequestsPg(db, owner))[0]!;
    expect(before.replies).toHaveLength(2);
    expect(before.replies.every(r => r.phone === null && r.email === null)).toBe(true);
    const mine = (await listRequestsPg(db, c1))[0]!;
    expect(mine).toMatchObject({ role: "contractor", myStatus: "sent", addressText: null, callbackPhone: null });

    const race = await Promise.all([replyToRequest(db, {}, actorOf(c1, "vendor"), sent.value.id, { kind: "accept", etaMinutes: 25 }), replyToRequest(db, {}, actorOf(c2, "vendor"), sent.value.id, { kind: "accept" })]);
    expect(race.filter(r => r.ok)).toHaveLength(1);
    const winner = race[0]!.ok ? c1 : c2, loser = winner === c1 ? c2 : c1;
    const after = (await listRequestsPg(db, owner))[0]!;
    expect(after.status).toBe("accepted");
    expect(after.replies.find(r => r.status === "accepted")?.phone).toBe("0412345678");
    expect(after.replies.find(r => r.status === "closed")?.phone).toBeNull();
    expect(await listRequestsPg(db, winner).then(r => r[0])).toMatchObject({ myStatus: "accepted", addressText: "12 Example St", callbackPhone: "0412000111" });
    expect(await listRequestsPg(db, loser).then(r => r[0])).toMatchObject({ myStatus: "closed", addressText: null });
    expect((await replyToRequest(db, {}, actorOf(loser, "vendor"), sent.value.id, { kind: "decline" })).ok).toBe(false);
    expect((await cancelRequest(db, actorOf(owner), sent.value.id)).ok).toBe(false);
    expect((await one("SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND kind = 'emergency_accepted'", [owner]))["n"]).toBe(1);
  });

  it("a suspended contractor is not asked and cannot accept a request they already received", async () => {
    const c = await vendor(); await saveProfilePg(db, c, prof({ serviceSuburbs: ["Indooroopilly"], servicePostcodes: ["4068"] }));
    const owner = await addUser(db, "owner");
    const req = await submitUrgentRequest(db, {}, actorOf(owner), { ...ask, suburb: "Indooroopilly", postcode: "4068" }, NOW);
    if (!req.ok) throw new Error(req.message);
    const staff = await addUser(db, "admin");
    await db.query("INSERT INTO contractor_standing (user_id, suspended, reason, changed_by) VALUES ($1, true, 'Under review', $2)", [c, staff]);
    expect((await candidatesPg(db, "plumber")).map(x => x.userId)).not.toContain(c);
    expect((await replyToRequest(db, {}, actorOf(c, "vendor"), req.value.id, { kind: "accept" })).ok).toBe(false);
    expect((await listRequestsPg(db, owner)).find(r => r.id === req.value.id)!.status).toBe("open");
  });

  it("decline, cancel, expiry and the rate limit", async () => {
    const c = await vendor(); await saveProfilePg(db, c, prof({ serviceSuburbs: ["Toowong"], servicePostcodes: ["4066"] }));
    const owner = await addUser(db, "owner");
    const toowong = { ...ask, suburb: "Toowong", postcode: "4066" };
    const a = await submitUrgentRequest(db, {}, actorOf(owner), toowong, NOW);
    if (!a.ok) throw new Error(a.message);
    expect((await replyToRequest(db, {}, actorOf(c, "vendor"), a.value.id, { kind: "decline", note: "Fully booked" })).ok).toBe(true);
    expect((await listRequestsPg(db, owner))[0]!.replies[0]).toMatchObject({ status: "declined", note: "Fully booked" });
    expect((await cancelRequest(db, actorOf(owner), a.value.id)).ok).toBe(true);
    expect((await listRequestsPg(db, owner))[0]!.status).toBe("cancelled");
    expect((await cancelRequest(db, actorOf(await addUser(db, "owner")), a.value.id)).ok).toBe(false);

    const b = await submitUrgentRequest(db, {}, actorOf(owner), toowong, NOW);
    expect(b.ok).toBe(true);
    // Third in the hour is refused.
    expect((await submitUrgentRequest(db, {}, actorOf(owner), toowong, new Date().toISOString())).ok).toBe(false);
    if (!b.ok) return;
    await db.query("UPDATE emergency_request SET created_at = now() - interval '7 hours' WHERE id = $1", [b.value.id]);
    expect((await listRequestsPg(db, owner)).find(r => r.id === b.value.id)!.status).toBe("expired");
    expect((await replyToRequest(db, {}, actorOf(c, "vendor"), b.value.id, { kind: "accept" })).ok).toBe(false);
  });

  it("uses the owner's own listing for the address and refuses someone else's", async () => {
    const owner = await addUser(db, "owner"), other = await addUser(db, "owner");
    const listingId = await addListing(db, owner);
    await db.query("UPDATE property_listing SET suburb = 'Paddington', postcode = '4064', transaction_type = 'rent' WHERE id = $1", [listingId]);
    const ok = await submitUrgentRequest(db, {}, actorOf(owner), { trade: "plumber", description: "Hot water system has burst", listingId }, NOW);
    expect(ok.ok).toBe(true);
    expect(await one("SELECT property_kind, suburb FROM emergency_request WHERE listing_id = $1", [listingId])).toMatchObject({ property_kind: "rental", suburb: "Paddington" });
    expect((await submitUrgentRequest(db, {}, actorOf(other), { trade: "plumber", description: "Hot water system has burst", listingId }, NOW)).ok).toBe(false);
  });
});
