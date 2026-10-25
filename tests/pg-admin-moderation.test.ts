import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signSession } from "../src/server/auth/session";
import { actorFromRequestChecked } from "../src/server/auth/actor";
import { loadUser, moderateListing, searchListings, searchUsers, setUserStatus } from "../src/server/admin-moderation-db";
import type { Queryable } from "../src/server/db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL with every migration applied. Skipped without DATABASE_URL (CI sets it).
const staff = { id: "00000000-0000-4000-8000-000000000001", role: "compliance" };
const event = (listingId: string, to: string) => ({
  id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user" as const, actorId: staff.id, aggregateType: "listing", aggregateId: listingId,
  eventType: `listing.${to}`, correlationId: randomUUID(), payload: { reason: "Photos show a different property.", moderation: true }
});

describe.skipIf(!DATABASE_URL)("admin moderation (Postgres)", () => {
  let t: TestDb;
  let db: Queryable;
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("the schema accepts suspended, and a suspend writes status and audit together", async () => {
    const owner = await addUser(db, "owner");
    const id = await addListing(db, owner, { status: "published", title: "Suspend me", suburb: "Paddington" });
    expect(await moderateListing(db, id, "published", "suspended", event(id, "suspended"))).toBe(true);
    expect((await db.query(`SELECT status FROM property_listing WHERE id = $1`, [id])).rows[0]!["status"]).toBe("suspended");
    // Lost race: the listing is no longer published, so nothing changes and no audit event is written.
    expect(await moderateListing(db, id, "published", "suspended", event(id, "suspended"))).toBe(false);
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_event WHERE aggregate_id = $1`, [id])).rows[0]!["n"]).toBe(1);
    const found = await searchListings(db, { q: "suspend", status: "suspended" });
    expect(found.rows.map(r => [r.id, r.lastReason])).toEqual([[id, "Photos show a different property."]]);
  });

  it("rolls the status back when the audit write fails", async () => {
    const owner = await addUser(db, "owner");
    const id = await addListing(db, owner, { status: "published" });
    await expect(moderateListing(db, id, "published", "suspended", { ...event(id, "suspended"), actorType: "robot" as never })).rejects.toThrow();
    expect((await db.query(`SELECT status FROM property_listing WHERE id = $1`, [id])).rows[0]!["status"]).toBe("published");
  });

  it("pages listings newest first and treats LIKE wildcards literally", async () => {
    const owner = await addUser(db, "owner");
    for (let i = 0; i < 55; i++) await addListing(db, owner, { title: `Paging ${i}`, jurisdiction: "WA", created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    const first = await searchListings(db, { jurisdiction: "WA" });
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0]!.title).toBe("Paging 54");
    const second = await searchListings(db, { jurisdiction: "WA", cursor: first.nextCursor! });
    expect(second.rows.map(r => r.title)).toEqual(["Paging 4", "Paging 3", "Paging 2", "Paging 1", "Paging 0"]);
    expect(second.nextCursor).toBeNull();
    expect((await searchListings(db, { q: "%" })).rows).toEqual([]);
  });

  it("a suspended account is refused on its next request and can be reinstated", async () => {
    const buyer = await addUser(db, "buyer");
    const secret = "s".repeat(40);
    const req = new Request("http://x", { headers: { cookie: `ol_session=${signSession({ uid: buyer, ut: "buyer", exp: 2_000_000_000 }, secret)}` } });
    expect(await actorFromRequestChecked(db, req, secret, 1_900_000_000)).not.toBeNull();
    expect(await setUserStatus(db, staff, buyer, "active", "suspended", "Repeated abusive messages.")).toBe(true);
    expect(await actorFromRequestChecked(db, req, secret, 1_900_000_000)).toBeNull();
    expect(await setUserStatus(db, staff, buyer, "active", "suspended", "Again.")).toBe(false);
    expect(await setUserStatus(db, staff, buyer, "suspended", "active", "Apology received.")).toBe(true);
    const detail = await loadUser(db, buyer, async () => false);
    expect(detail?.history.map(h => [h.eventType, h.reason])).toEqual([["user.reinstated", "Apology received."], ["user.suspended", "Repeated abusive messages."]]);
    expect(detail?.user.termsCurrent).toBe(false);
  });

  it("never changes or returns a staff account", async () => {
    const admin = await addUser(db, "admin");
    expect(await setUserStatus(db, staff, admin, "active", "suspended", "Should not work.")).toBe(false);
    expect(await loadUser(db, admin, async () => true)).toBeNull();
    expect((await searchUsers(db, { q: admin, searchPersonal: false })).rows).toEqual([]);
  });

  it("searches names and emails only when full personal details are allowed, and shows compliance facts", async () => {
    const agent = await addUser(db, "agent");
    await db.query(`UPDATE app_user SET display_name = 'Zelda Searchable' WHERE id = $1`, [agent]);
    const checker = await addUser(db, "admin");
    await db.query(`INSERT INTO agent_licence (user_id, jurisdiction, licence_number, status, verified_by, verified_at, expires_at)
                    VALUES ($1, 'QLD', 'L1', 'verified', $2, now(), '2020-01-01')`, [agent, checker]);
    expect((await searchUsers(db, { q: "zelda", searchPersonal: false })).rows).toEqual([]);
    const full = await searchUsers(db, { q: "zelda", searchPersonal: true });
    expect(full.rows.map(r => [r.id, r.licence])).toEqual([[agent, "expired"]]);
    expect((await searchUsers(db, { q: agent, searchPersonal: false })).rows).toHaveLength(1);
  });
});
