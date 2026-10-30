import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deletionWindows } from "../src/domain/account-deletion";
import { OWNER_COUNTER_FROM } from "../src/domain/offer-counter";
import { statusesAllowing } from "../src/domain/offer-decision";
import { deleteAccountPg, findDeletionTarget, listDeletedAccounts, restoreAccountPg, runAccountRetention } from "../src/server/account-deletion-db";
import { searchUsers } from "../src/server/admin-moderation-db";
import { sessionFromRequestChecked } from "../src/server/auth/actor";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from "../src/server/auth/session";
import { ownerCounterPg } from "../src/server/offer-counter-db";
import { decideOfferPg } from "../src/server/offer-flow-db";
import { submitOfferPg } from "../src/server/offers-db";
import { upsertGoogleUser } from "../src/server/users";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL: deletion, restore and retention are guarded statements, so their WHERE clauses and the table constraint are the rules.
const T0 = "2026-10-29T00:00:00.000Z";
const at = (days: number) => new Date(Date.parse(T0) + days * 86_400_000).toISOString();
const STAFF = (id: string) => ({ id, role: "super_admin" });
const REASON = "Owner asked by phone to close the account";

describe.skipIf(!DATABASE_URL)("account deletion (Postgres)", () => {
  let t: TestDb;
  let db: TestDb["db"];
  beforeAll(async () => { t = await createTestDb(); db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  const one = async (sql: string, p: unknown[]) => (await db.query(sql, p)).rows[0]!;
  const offerOn = async (listingId: string, buyer: string, now = at(-1)) => {
    const tokenHash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3,$4)", [tokenHash, listingId, buyer, at(1)]);
    const saved = await submitOfferPg(db, { tokenHash, listingId, priceCents: 90_000_000, conditions: [], settlementDays: 42, depositCents: 9_000_000, now });
    return saved!.id;
  };
  const status = async (table: "formal_offer" | "property_listing" | "app_user", id: string) => String((await one(`SELECT status FROM ${table} WHERE id = $1`, [id]))["status"]);

  /** An owner with a live, a draft, a suspended and a withdrawn listing; a pending offer, a countered offer and an accepted offer. */
  async function world() {
    const admin = await addUser(db, "admin");
    const owner = await addUser(db, "owner");
    const buyerA = await addUser(db, "buyer");
    const buyerB = await addUser(db, "buyer");
    const live = await addListing(db, owner, { status: "published", title: "3 Bay St" });
    const sold = await addListing(db, owner, { status: "published", title: "9 Hill Rd" });
    const draft = await addListing(db, owner, { status: "draft" });
    const susp = await addListing(db, owner, { status: "suspended" });
    const gone = await addListing(db, owner, { status: "withdrawn" });
    const pending = await offerOn(live, buyerA);
    const countered = await offerOn(live, buyerB);
    await ownerCounterPg(db, live, OWNER_COUNTER_FROM, { offerId: countered, userId: owner, now: at(-0.9), expiresAt: at(3), priceCents: 95_000_000, depositCents: 9_500_000, settlementDays: 30, conditions: [] });
    const accepted = await offerOn(sold, buyerA);
    expect(await decideOfferPg(db, sold, accepted, owner, statusesAllowing("accept"), "accepted", at(-0.8))).toBe(true);
    return { admin, owner, buyerA, buyerB, live, sold, draft, susp, gone, pending, countered, accepted };
  }

  it("shows what a deletion touches, then soft-deletes: archives listings, cancels negotiations, keeps accepted offers and all records", async () => {
    const w = await world();
    expect(await findDeletionTarget(db, { id: w.owner })).toMatchObject({ status: "active", deletedAt: null, listings: 4, pendingOffers: 2, liveOffers: 1 });

    const done = await deleteAccountPg(db, STAFF(w.admin), w.owner, REASON, T0, deletionWindows(T0));
    expect(done!.listings.map(l => [l.id, l.from]).sort()).toEqual([[w.draft, "draft"], [w.live, "published"], [w.sold, "published"], [w.susp, "suspended"]].sort());
    expect(done!.liveOffers).toBe(1);
    expect(done!.cancelledOffers.map(o => o.offerId).sort()).toEqual([w.pending, w.countered].sort());
    // The other side of each cancelled offer is the buyer, told by email.
    expect(done!.cancelledOffers.every(o => o.notify?.role === "buyer" && o.notify.email.endsWith("@example.test") && o.listingTitle === "3 Bay St")).toBe(true);

    const u = await one("SELECT status, status_before_delete, deleted_at, restore_until, retain_until, deactivated_at, email FROM app_user WHERE id = $1", [w.owner]);
    expect(u).toMatchObject({ status: "closed", status_before_delete: "active", deactivated_at: null });
    expect((u["deleted_at"] as Date).toISOString()).toBe(T0);
    expect((u["restore_until"] as Date).toISOString()).toBe(at(30));
    expect((u["retain_until"] as Date).toISOString()).toBe("2033-10-29T00:00:00.000Z");
    expect(u["email"]).toMatch(/@example\.test$/);

    for (const id of [w.live, w.sold, w.draft, w.susp]) expect(await status("property_listing", id)).toBe("archived");
    expect(await status("property_listing", w.gone)).toBe("withdrawn");
    expect(await status("formal_offer", w.pending)).toBe("withdrawn");
    expect(await status("formal_offer", w.countered)).toBe("withdrawn");
    expect(await status("formal_offer", w.accepted)).toBe("accepted");
    const open = await one("SELECT count(*)::int AS n FROM offer_counter WHERE offer_id = $1 AND status = 'open'", [w.countered]);
    expect(open["n"]).toBe(0);
    const ev = await db.query("SELECT event_type, actor_kind, from_status, to_status FROM offer_event WHERE offer_id = $1 ORDER BY occurred_at", [w.countered]);
    expect(ev.rows.at(-1)).toEqual({ event_type: "withdrawn", actor_kind: "system", from_status: "countered", to_status: "withdrawn" });
    const audit = await db.query("SELECT event_type FROM audit_event WHERE payload->>'withAccount' = $1 OR aggregate_id = $1 ORDER BY event_type", [w.owner]);
    expect(audit.rows.map(r => r["event_type"])).toEqual(["listing.archived", "listing.archived", "listing.archived", "listing.archived", "user.deleted"]);

    // Nothing was removed: the offers and listings are all still there to read.
    const kept = await one("SELECT count(*)::int AS n FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE l.owner_user_id = $1", [w.owner]);
    expect(kept["n"]).toBe(3);

    // A second deletion does nothing; the account no longer shows in the user search and is listed as deleted instead.
    expect(await deleteAccountPg(db, STAFF(w.admin), w.owner, REASON, at(1), deletionWindows(at(1)))).toBeNull();
    const search = await searchUsers(db, { q: w.owner, searchPersonal: true });
    expect(search.rows).toEqual([]);
    const listed = (await listDeletedAccounts(db)).rows.find(r => r.id === w.owner);
    expect(listed).toMatchObject({ reason: REASON, archivedListings: 4, cancelledOffers: 2, liveOffers: 1, deactivatedAt: null, purgedAt: null });
    expect(listed!.deletedBy).toMatch(/@example\.test$/);
  });

  it("a buyer's deletion cancels their own negotiating offers and the owner is the one told", async () => {
    const w = await world();
    const done = await deleteAccountPg(db, STAFF(w.admin), w.buyerB, REASON, T0, deletionWindows(T0));
    expect(done!.listings).toEqual([]);
    expect(done!.cancelledOffers).toEqual([expect.objectContaining({ offerId: w.countered, notify: { role: "owner", email: expect.stringMatching(/@example\.test$/) } })]);
    expect(await status("formal_offer", w.pending)).toBe("submitted");
    expect(await status("property_listing", w.live)).toBe("published");
  });

  it("restores inside the window with the previous status and listings, but not the cancelled offers; refuses after the window", async () => {
    const w = await world();
    await db.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [w.owner]);
    await deleteAccountPg(db, STAFF(w.admin), w.owner, REASON, T0, deletionWindows(T0));
    const back = await restoreAccountPg(db, STAFF(w.admin), w.owner, "Owner called back within the window", at(29));
    expect(back!.status).toBe("suspended");
    const to = Object.fromEntries(back!.listings.map(l => [l.id, [l.to, l.wasPublished]]));
    expect(to).toEqual({ [w.live]: ["suspended", true], [w.sold]: ["suspended", true], [w.draft]: ["draft", false], [w.susp]: ["suspended", false] });
    expect(await status("property_listing", w.draft)).toBe("draft");
    expect(await status("property_listing", w.live)).toBe("suspended");
    expect(await status("formal_offer", w.pending)).toBe("withdrawn");
    const u = await one("SELECT deleted_at, restore_until, retain_until, status_before_delete, restored_at FROM app_user WHERE id = $1", [w.owner]);
    expect(u).toMatchObject({ deleted_at: null, restore_until: null, retain_until: null, status_before_delete: null });
    expect((u["restored_at"] as Date).toISOString()).toBe(at(29));
    expect(await restoreAccountPg(db, STAFF(w.admin), w.owner, "Owner called back a second time", at(29))).toBeNull();

    const late = await world();
    await deleteAccountPg(db, STAFF(late.admin), late.owner, REASON, T0, deletionWindows(T0));
    expect(await restoreAccountPg(db, STAFF(late.admin), late.owner, "Owner called back too late", at(30))).toBeNull();
    expect(await status("app_user", late.owner)).toBe("closed");
  });

  it("signs the account out at once, refuses Google sign-in while deleted, and a restore never revives an old session", async () => {
    const admin = await addUser(db, "admin");
    const sub = `google-${randomUUID()}`;
    const who = { sub, email: `${randomUUID()}@example.test`, name: "Olive" };
    const user = (await upsertGoogleUser(db, who, "owner"))!;
    const SECRET = "s".repeat(40);
    const nowS = Math.floor(Date.now() / 1000);
    const req = (iat: number) => new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid: user.id, ut: "owner", exp: iat + SESSION_TTL_SECONDS }, SECRET)}` } });
    await db.query("UPDATE app_user SET email = $2 WHERE id = $1", [user.id, who.email]);
    // The session itself (the second-factor step comes after this check and is covered by the MFA tests).
    const before = req(nowS - 60);
    const signedIn = async (r: Request, s: number) => (await sessionFromRequestChecked(db, r, SECRET, s)) !== null;
    expect(await signedIn(before, nowS)).toBe(true);

    const nowIso = new Date(nowS * 1000).toISOString();
    await deleteAccountPg(db, STAFF(admin), user.id, REASON, nowIso, deletionWindows(nowIso));
    expect(await signedIn(before, nowS)).toBe(false);
    expect(await upsertGoogleUser(db, who, "owner")).toBeNull();
    expect(String((await one("SELECT email::text AS e FROM app_user WHERE id = $1", [user.id]))["e"])).toBe(who.email);

    const restoredAt = new Date((nowS + 5) * 1000).toISOString();
    await restoreAccountPg(db, STAFF(admin), user.id, "Owner called back within the window", restoredAt);
    expect(await signedIn(before, nowS + 10)).toBe(false);
    expect(await signedIn(req(nowS + 6), nowS + 10)).toBe(true);
    expect(await upsertGoogleUser(db, who, "owner")).toEqual({ id: user.id, userType: "owner" });
  });

  it("retention: the deletion becomes final after the window, and after 7 years name, email, Google link and phone are cleared", async () => {
    const w = await world();
    await db.query("UPDATE app_user SET google_sub = $2 WHERE id = $1", [w.owner, `google-${randomUUID()}`]);
    await db.query("INSERT INTO buyer_verification (user_id, phone_e164, phone_verified_at) VALUES ($1, '+61400111222', now())", [w.owner]);
    await deleteAccountPg(db, STAFF(w.admin), w.owner, REASON, T0, deletionWindows(T0));
    const row = async () => one("SELECT email, display_name, google_sub, deactivated_at, personal_data_purged_at FROM app_user WHERE id = $1", [w.owner]);

    await runAccountRetention(db, at(29));
    expect((await row())["deactivated_at"]).toBeNull();
    const first = await runAccountRetention(db, at(31));
    expect(first.finalised).toBeGreaterThanOrEqual(1);
    expect(((await row())["deactivated_at"] as Date).toISOString()).toBe(at(31));
    expect(await restoreAccountPg(db, STAFF(w.admin), w.owner, "Owner called back after it was final", at(20))).toBeNull();

    await runAccountRetention(db, "2033-10-28T23:59:59.000Z");
    expect((await row())["personal_data_purged_at"]).toBeNull();
    const purge = await runAccountRetention(db, "2033-10-29T00:00:00.000Z");
    expect(purge.purged).toBeGreaterThanOrEqual(1);
    expect(await row()).toMatchObject({ email: null, display_name: "Deleted account", google_sub: null });
    expect((await one("SELECT phone_e164 FROM buyer_verification WHERE user_id = $1", [w.owner]))["phone_e164"]).toBeNull();
    // The anonymous records stay: offers, offer history and the audit trail.
    expect((await one("SELECT count(*)::int AS n FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE l.owner_user_id = $1", [w.owner]))["n"]).toBe(3);
    const ev = await db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'user' AND aggregate_id = $1 ORDER BY occurred_at", [w.owner]);
    expect(ev.rows.map(r => r["event_type"])).toEqual(["user.deleted", "user.deletion_final", "user.personal_data_purged"]);
    // Running again changes nothing.
    const again = await runAccountRetention(db, "2034-01-01T00:00:00.000Z");
    expect(await one("SELECT count(*)::int AS n FROM audit_event WHERE aggregate_id = $1 AND event_type = 'user.personal_data_purged'", [w.owner])).toEqual({ n: 1 });
    expect(again.purged).toBe(0);
  });

  it("the table refuses a deleted account that is not closed, or windows out of order; two deletions at once, one wins", async () => {
    const admin = await addUser(db, "admin");
    const owner = await addUser(db, "owner");
    await expect(db.query("UPDATE app_user SET deleted_at = now(), restore_until = now() + interval '30 days', retain_until = now() + interval '7 years', status_before_delete = 'active' WHERE id = $1", [owner])).rejects.toThrow();
    await expect(db.query("UPDATE app_user SET status = 'closed', deleted_at = now(), restore_until = now() - interval '1 day', retain_until = now() + interval '7 years', status_before_delete = 'active' WHERE id = $1", [owner])).rejects.toThrow();
    await expect(db.query("UPDATE app_user SET personal_data_purged_at = now() WHERE id = $1", [owner])).rejects.toThrow();
    const [a, b] = await Promise.all([
      deleteAccountPg(db, STAFF(admin), owner, REASON, T0, deletionWindows(T0)),
      deleteAccountPg(db, STAFF(admin), owner, REASON, T0, deletionWindows(T0))
    ]);
    expect([a, b].filter(x => x !== null)).toHaveLength(1);
    expect(await deleteAccountPg(db, STAFF(admin), admin, REASON, T0, deletionWindows(T0))).toBeNull();
  });

  it("retention edge cases: a restore before expiry is never finalised, a new deletion gets a fresh window, every run is logged", async () => {
    const w = await world();
    const runs = async () => (await one("SELECT count(*)::int AS n FROM audit_event WHERE aggregate_type = 'job' AND event_type = 'job.account_retention_run'", []))["n"] as number;
    const before = await runs();
    await deleteAccountPg(db, STAFF(w.admin), w.owner, REASON, T0, deletionWindows(T0));
    expect(await restoreAccountPg(db, STAFF(w.admin), w.owner, "Owner called back within the window", at(10))).not.toBeNull();
    // Past the old window: the restored account is left alone.
    await runAccountRetention(db, at(31));
    expect(await one("SELECT status, deactivated_at FROM app_user WHERE id = $1", [w.owner])).toMatchObject({ status: "active", deactivated_at: null });
    // Deleted again later: the window runs from the new deletion, not the first one.
    await deleteAccountPg(db, STAFF(w.admin), w.owner, REASON, at(40), deletionWindows(at(40)));
    await runAccountRetention(db, at(69));
    expect((await one("SELECT deactivated_at FROM app_user WHERE id = $1", [w.owner]))["deactivated_at"]).toBeNull();
    // Exactly at the end of the window it becomes final.
    await runAccountRetention(db, at(70));
    expect(((await one("SELECT deactivated_at FROM app_user WHERE id = $1", [w.owner]))["deactivated_at"] as Date).toISOString()).toBe(at(70));
    // A run with nothing due still leaves a record with its counts.
    const idle = await runAccountRetention(db, at(70));
    expect(idle).toEqual({ finalised: 0, purged: 0 });
    expect(await runs()).toBe(before + 4);
    const logged = await db.query("SELECT payload FROM audit_event WHERE aggregate_type = 'job' AND occurred_at = $1", [at(70)]);
    expect(logged.rows.map(r => r["payload"])).toContainEqual({ finalised: 0, purged: 0 });
  });
});
