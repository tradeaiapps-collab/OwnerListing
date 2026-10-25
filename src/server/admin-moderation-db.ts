import { randomUUID } from "node:crypto";
import type { ComplianceFacts } from "../domain/admin-moderation";
import type { AuditEvent } from "../domain/audit";
import type { ListingStatus } from "../domain/listing";
import { decodeCursor, encodeCursor } from "../domain/pagination";
import { appendAuditPg, type Queryable } from "./db";

/** Staff moderation reads and writes. Parameterised SQL only; each change and its audit event commit together or not at all. */

const PAGE = 50;
const n = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));

export interface ListingFilters { q?: string; status?: string; jurisdiction?: string; transactionType?: string; cursor?: string }
export interface StaffListingRow {
  id: string; title: string; suburb: string | null; jurisdiction: string; transactionType: string; propertyType: string;
  status: string; priceCents: number | null; createdAt: string; ownerType: string; offers: number; lastReason: string | null;
}

/** Every listing, newest first, filtered and paged (keyset). Owner identity is not selected; staff open the listing by id. */
export async function searchListings(db: Queryable, f: ListingFilters): Promise<{ rows: StaffListingRow[]; nextCursor: string | null }> {
  const cur = f.cursor ? decodeCursor(f.cursor) : null;
  const res = await db.query(
    `SELECT l.id, l.title, l.suburb, l.jurisdiction, l.transaction_type, l.property_type, l.status, l.price_cents, l.created_at, o.user_type AS owner_type,
            (SELECT count(*)::int FROM formal_offer f WHERE f.listing_id = l.id) AS offers,
            (SELECT e.payload->>'reason' FROM audit_event e WHERE e.aggregate_type = 'listing' AND e.aggregate_id = l.id::text
                AND e.payload ? 'moderation' ORDER BY e.occurred_at DESC LIMIT 1) AS last_reason
       FROM property_listing l JOIN app_user o ON o.id = l.owner_user_id
      WHERE ($1::text IS NULL OR l.title ILIKE $1 OR l.address_text ILIKE $1 OR l.suburb ILIKE $1 OR l.postcode = $2 OR l.id::text = $2)
        AND ($3::text IS NULL OR l.status = $3) AND ($4::text IS NULL OR l.jurisdiction = $4) AND ($5::text IS NULL OR l.transaction_type = $5)
        AND ($6::timestamptz IS NULL OR (l.created_at, l.id) < ($6::timestamptz, $7::uuid))
      ORDER BY l.created_at DESC, l.id DESC LIMIT $8`,
    [f.q ? `%${f.q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null, f.q ?? null, f.status || null, f.jurisdiction || null, f.transactionType || null,
      cur?.sortValue ?? null, cur?.id ?? null, PAGE + 1]
  );
  const rows = res.rows.slice(0, PAGE).map(r => ({
    id: String(r["id"]), title: String(r["title"]), suburb: r["suburb"] === null ? null : String(r["suburb"]), jurisdiction: String(r["jurisdiction"]).trim(),
    transactionType: String(r["transaction_type"]), propertyType: String(r["property_type"]), status: String(r["status"]),
    priceCents: r["price_cents"] === null ? null : n(r["price_cents"]), createdAt: iso(r["created_at"]), ownerType: String(r["owner_type"]),
    offers: n(r["offers"]), lastReason: typeof r["last_reason"] === "string" ? r["last_reason"] : null
  }));
  const last = rows[rows.length - 1];
  return { rows, nextCursor: res.rows.length > PAGE && last ? encodeCursor({ sortValue: last.createdAt, id: last.id }) : null };
}

/**
 * Moves a listing from `from` to `to` only if it is still in `from` (row lock plus guarded UPDATE), and writes the audit event in the
 * same transaction. False when someone else changed it first.
 */
export async function moderateListing(db: Queryable, id: string, from: ListingStatus, to: ListingStatus, event: AuditEvent): Promise<boolean> {
  return inTx(db, async tx => {
    const done = await tx.query(`UPDATE property_listing SET status = $3, updated_at = now() WHERE id = $1 AND status = $2 RETURNING id`, [id, from, to]);
    if (done.rows.length === 0) return false;
    await appendAuditPg(tx, event);
    return true;
  });
}

export interface UserFilters { q?: string; userType?: string; status?: string; cursor?: string; searchPersonal: boolean }
export interface StaffUserRow extends ComplianceFacts {
  id: string; name: string; email: string | null; userType: string; status: string; createdAt: string; listings: number;
}

const COMPLIANCE_SELECT = `
  u.id, u.display_name, u.email::text AS email, u.user_type, u.status, u.created_at,
  (bv.email_verified_at IS NOT NULL) AS email_verified, (bv.phone_verified_at IS NOT NULL) AS phone_verified, (bv.id_verified_at IS NOT NULL) AS id_verified,
  EXISTS (SELECT 1 FROM id_submission s WHERE s.user_id = u.id AND s.status = 'pending') AS id_pending,
  EXISTS (SELECT 1 FROM agent_licence a WHERE a.user_id = u.id AND a.status = 'verified' AND (a.expires_at IS NULL OR a.expires_at >= current_date)) AS licence_ok,
  EXISTS (SELECT 1 FROM agent_licence a WHERE a.user_id = u.id AND a.status = 'verified') AS licence_any,
  (SELECT count(*)::int FROM admin_case c WHERE c.subject_id = u.id AND c.status <> 'resolved') AS open_cases,
  (SELECT count(*)::int FROM property_listing l WHERE l.owner_user_id = u.id) AS listings`;

function toUserRow(r: Record<string, unknown>, termsCurrent: boolean): StaffUserRow {
  const type = String(r["user_type"]);
  return {
    id: String(r["id"]), name: String(r["display_name"] ?? ""), email: typeof r["email"] === "string" ? r["email"] : null, userType: type,
    status: String(r["status"]), createdAt: iso(r["created_at"]), listings: n(r["listings"]),
    emailVerified: r["email_verified"] === true, phoneVerified: r["phone_verified"] === true, idVerified: r["id_verified"] === true,
    idPending: r["id_pending"] === true, openCases: n(r["open_cases"]), termsCurrent,
    licence: type !== "agent" ? "not_needed" : r["licence_ok"] === true ? "verified" : r["licence_any"] === true ? "expired" : "missing"
  };
}

/**
 * Non-staff accounts, newest first, paged. Free-text search on name and email only when the caller may see full personal details
 * (searchPersonal); otherwise only an exact account id matches, so a masked view cannot be used to test whether an email exists.
 * Terms status is not in the list (it is per user); see loadUser.
 */
export async function searchUsers(db: Queryable, f: UserFilters): Promise<{ rows: StaffUserRow[]; nextCursor: string | null }> {
  const cur = f.cursor ? decodeCursor(f.cursor) : null;
  const q = f.q?.trim() || null;
  const res = await db.query(
    `SELECT ${COMPLIANCE_SELECT}
       FROM app_user u LEFT JOIN buyer_verification bv ON bv.user_id = u.id
      WHERE u.user_type <> 'admin'
        AND ($1::text IS NULL OR u.id::text = $1 OR ($2 AND (u.email::text ILIKE $3 OR u.display_name ILIKE $3)))
        AND ($4::text IS NULL OR u.user_type = $4) AND ($5::text IS NULL OR u.status = $5)
        AND ($6::timestamptz IS NULL OR (u.created_at, u.id) < ($6::timestamptz, $7::uuid))
      ORDER BY u.created_at DESC, u.id DESC LIMIT $8`,
    [q, f.searchPersonal, q ? `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null, f.userType || null, f.status || null,
      cur?.sortValue ?? null, cur?.id ?? null, PAGE + 1]
  );
  const rows = res.rows.slice(0, PAGE).map(r => toUserRow(r, true));
  const last = rows[rows.length - 1];
  return { rows, nextCursor: res.rows.length > PAGE && last ? encodeCursor({ sortValue: last.createdAt, id: last.id }) : null };
}

export interface AccountEvent { occurredAt: string; eventType: string; reason: string | null }

/** One account with compliance facts and its moderation history (newest first). Staff accounts are never returned. */
export async function loadUser(db: Queryable, id: string, termsCurrent: (id: string) => Promise<boolean>): Promise<{ user: StaffUserRow; history: AccountEvent[] } | null> {
  const r = (await db.query(`SELECT ${COMPLIANCE_SELECT} FROM app_user u LEFT JOIN buyer_verification bv ON bv.user_id = u.id WHERE u.id = $1 AND u.user_type <> 'admin'`, [id])).rows[0];
  if (!r) return null;
  const history = await db.query(
    `SELECT occurred_at, event_type, payload->>'reason' AS reason FROM audit_event
      WHERE aggregate_type = 'user' AND aggregate_id = $1 AND event_type IN ('user.suspended', 'user.reinstated') ORDER BY occurred_at DESC LIMIT 50`, [id]);
  return {
    user: toUserRow(r, await termsCurrent(id)),
    history: history.rows.map(h => ({ occurredAt: iso(h["occurred_at"]), eventType: String(h["event_type"]), reason: typeof h["reason"] === "string" ? h["reason"] : null }))
  };
}

/** The fields planUserAction needs, read fresh. */
export async function userTarget(db: Queryable, id: string): Promise<{ id: string; userType: string; status: string } | null> {
  const r = (await db.query(`SELECT id, user_type, status FROM app_user WHERE id = $1`, [id])).rows[0];
  return r ? { id: String(r["id"]), userType: String(r["user_type"]), status: String(r["status"]) } : null;
}

/**
 * Guarded status change for a non-staff account, audited in the same transaction. Null when the account changed in between.
 * With suspendListings, every live listing of the account is suspended in the same transaction, each with its own audit event, and
 * their ids are kept on the account's event so a later reinstatement can bring back exactly those listings.
 */
export async function setUserStatus(
  db: Queryable, staff: { id: string; role: string }, id: string, from: string, to: "suspended" | "active", reason: string,
  opts: { suspendListings?: boolean } = {}
): Promise<{ listingIds: string[] } | null> {
  return inTx(db, async tx => {
    const done = await tx.query(`UPDATE app_user SET status = $3 WHERE id = $1 AND status = $2 AND user_type <> 'admin' RETURNING id`, [id, from, to]);
    if (done.rows.length === 0) return null;
    const now = new Date().toISOString();
    const correlationId = randomUUID();
    const listingIds = to === "suspended" && opts.suspendListings
      ? (await tx.query(
          `UPDATE property_listing SET status = 'suspended', updated_at = now() WHERE owner_user_id = $1 AND status = 'published' RETURNING id`, [id]
        )).rows.map(r => String(r["id"]))
      : [];
    for (const listingId of listingIds) {
      await appendAuditPg(tx, {
        id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "listing", aggregateId: listingId,
        eventType: "listing.suspended", correlationId,
        payload: { from: "published", to: "suspended", role: staff.role, action: "suspend", reason, moderation: true, withAccount: id }
      });
    }
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "user", aggregateId: id,
      eventType: to === "suspended" ? "user.suspended" : "user.reinstated", correlationId,
      payload: {
        role: staff.role, from, to, reason, moderation: true,
        ...(to === "suspended" ? { listings: opts.suspendListings ? "suspended" : "kept", listingIds } : {})
      }
    });
    return { listingIds };
  });
}

/** Listings suspended together with the account's latest suspension that are still suspended (and still the account's). */
export async function listingsSuspendedWithAccount(db: Queryable, id: string): Promise<string[]> {
  const ev = (await db.query(
    `SELECT payload->'listingIds' AS ids FROM audit_event
      WHERE aggregate_type = 'user' AND aggregate_id = $1 AND event_type = 'user.suspended' ORDER BY occurred_at DESC LIMIT 1`, [id]
  )).rows[0];
  const ids = Array.isArray(ev?.["ids"]) ? (ev["ids"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return [];
  const res = await db.query(
    `SELECT id FROM property_listing WHERE id = ANY($1::uuid[]) AND owner_user_id = $2 AND status = 'suspended' ORDER BY created_at, id`, [ids, id]
  );
  return res.rows.map(r => String(r["id"]));
}
