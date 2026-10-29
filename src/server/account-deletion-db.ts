import { randomUUID } from "node:crypto";
import {
  ARCHIVABLE_LISTING_STATUSES, LIVE_OFFER_STATUSES, PENDING_OFFER_STATUSES, type DeletionTarget, type DeletionWindows
} from "../domain/account-deletion";
import { decodeCursor, encodeCursor } from "../domain/pagination";
import { appendAuditPg, type Queryable } from "./db";

/**
 * Account deletion reads and writes. Parameterised SQL only. Each deletion or restore commits together with its audit events, or not
 * at all, and each step is a guarded UPDATE so two staff members acting at once cannot both succeed.
 */

const PAGE = 50;
const n = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const str = (v: unknown) => (typeof v === "string" ? v : null);
const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));

export interface DeletionView extends DeletionTarget {
  displayName: string;
  /** Listings that would be archived (not withdrawn or already archived). */
  listings: number;
  /** Offers still being negotiated, as buyer or on the account's listings: these would be cancelled. */
  pendingOffers: number;
  /** Accepted offers, as buyer or on the account's listings: these continue untouched. */
  liveOffers: number;
}

/** A non-staff account by email or id, with what a deletion would touch. */
export async function findDeletionTarget(db: Queryable, by: { email: string } | { id: string }): Promise<DeletionView | null> {
  const r = (await db.query(
    `SELECT u.id, u.email::text AS email, u.display_name, u.user_type, u.status, u.deleted_at, u.restore_until, u.deactivated_at,
            (SELECT count(*)::int FROM property_listing l WHERE l.owner_user_id = u.id AND l.status = ANY($2::text[])) AS listings,
            (SELECT count(*)::int FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
              WHERE (o.buyer_user_id = u.id OR l.owner_user_id = u.id) AND o.status = ANY($3::text[])) AS pending,
            (SELECT count(*)::int FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
              WHERE (o.buyer_user_id = u.id OR l.owner_user_id = u.id) AND o.status = ANY($4::text[])) AS live
       FROM app_user u WHERE ${"email" in by ? "u.email = $1" : "u.id = $1::uuid"} AND u.user_type <> 'admin'`,
    ["email" in by ? by.email : by.id, [...ARCHIVABLE_LISTING_STATUSES], [...PENDING_OFFER_STATUSES], [...LIVE_OFFER_STATUSES]]
  )).rows[0];
  if (!r) return null;
  return {
    id: String(r["id"]), email: str(r["email"]), displayName: String(r["display_name"] ?? ""), userType: String(r["user_type"]),
    status: String(r["status"]), deletedAt: isoOrNull(r["deleted_at"]), restoreUntil: isoOrNull(r["restore_until"]),
    deactivatedAt: isoOrNull(r["deactivated_at"]), listings: n(r["listings"]), pendingOffers: n(r["pending"]), liveOffers: n(r["live"])
  };
}

export interface CancelledOffer { offerId: string; listingTitle: string; notify: { role: "buyer" | "owner"; email: string } | null }
export interface DeletionResult { listings: { id: string; from: string }[]; cancelledOffers: CancelledOffer[]; liveOffers: number }

/**
 * Deletes (soft) a non-staff account in one transaction:
 * - closes the account and records the windows (the session check refuses a closed account on its next request);
 * - archives its listings, keeping each one's previous status for a restore;
 * - cancels offers still being negotiated on either side (open counters close too; the offer history records a system withdrawal);
 * - leaves accepted offers and everything already finished as they are.
 * Null when the account was already deleted or changed in between.
 */
export async function deleteAccountPg(
  db: Queryable, staff: { id: string; role: string }, userId: string, reason: string, now: string, w: DeletionWindows
): Promise<DeletionResult | null> {
  return inTx(db, async tx => {
    const done = await tx.query(
      `UPDATE app_user SET status_before_delete = status, status = 'closed', deleted_at = $2, restore_until = $3, retain_until = $4
        WHERE id = $1 AND deleted_at IS NULL AND user_type <> 'admin' AND status IN ('pending', 'active', 'suspended') RETURNING id`,
      [userId, now, w.restoreUntil, w.retainUntil]);
    if (done.rows.length === 0) return null;

    const listings = (await tx.query(
      `WITH target AS (
         SELECT id, status FROM property_listing WHERE owner_user_id = $1 AND status = ANY($2::text[]) FOR UPDATE
       )
       UPDATE property_listing l SET status = 'archived', updated_at = $3 FROM target t WHERE l.id = t.id
       RETURNING l.id, t.status AS from_status`,
      [userId, [...ARCHIVABLE_LISTING_STATUSES], now]
    )).rows.map(r => ({ id: String(r["id"]), from: String(r["from_status"]) }));

    // Data-modifying CTEs all run once, whether or not the final SELECT reads them.
    const offers = (await tx.query(
      `WITH target AS (
         SELECT o.id, o.status AS from_status, o.buyer_user_id, l.owner_user_id, l.title
           FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
          WHERE (o.buyer_user_id = $1 OR l.owner_user_id = $1) AND o.status = ANY($2::text[])
          FOR UPDATE OF o
       ), closed AS (
         UPDATE offer_counter x SET status = 'withdrawn', closed_at = $3 FROM target t WHERE x.offer_id = t.id AND x.status = 'open' RETURNING x.id
       ), moved AS (
         UPDATE formal_offer o SET status = 'withdrawn' FROM target t WHERE o.id = t.id RETURNING o.id
       ), logged AS (
         INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, from_status, to_status, occurred_at)
         SELECT m.id, 'withdrawn', 'system', NULL, t.from_status, 'withdrawn', $3 FROM moved m JOIN target t ON t.id = m.id
         RETURNING offer_id
       )
       SELECT t.id, t.title, (t.buyer_user_id = $1) AS deleted_is_buyer, other.email::text AS other_email, other.deleted_at AS other_deleted
         FROM target t
         JOIN app_user other ON other.id = CASE WHEN t.buyer_user_id = $1 THEN t.owner_user_id ELSE t.buyer_user_id END
        ORDER BY t.id`,
      [userId, [...PENDING_OFFER_STATUSES], now]
    )).rows.map((r): CancelledOffer => {
      const email = str(r["other_email"]);
      return {
        offerId: String(r["id"]), listingTitle: String(r["title"]),
        notify: email && r["other_deleted"] === null ? { role: r["deleted_is_buyer"] === true ? "owner" : "buyer", email } : null
      };
    });

    const live = (await tx.query(
      `SELECT count(*)::int AS n FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
        WHERE (o.buyer_user_id = $1 OR l.owner_user_id = $1) AND o.status = ANY($2::text[])`,
      [userId, [...LIVE_OFFER_STATUSES]])).rows[0];

    const correlationId = randomUUID();
    for (const l of listings) {
      await appendAuditPg(tx, {
        id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "listing", aggregateId: l.id,
        eventType: "listing.archived", correlationId, payload: { from: l.from, to: "archived", role: staff.role, reason, withAccount: userId }
      });
    }
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "user", aggregateId: userId,
      eventType: "user.deleted", correlationId,
      payload: {
        role: staff.role, reason, restoreUntil: w.restoreUntil, retainUntil: w.retainUntil,
        listings, cancelledOffers: offers.map(o => o.offerId), liveOffers: n(live?.["n"])
      }
    });
    return { listings, cancelledOffers: offers, liveOffers: n(live?.["n"]) };
  });
}

export interface RestoreResult { status: string; listings: { id: string; to: string; wasPublished: boolean }[] }

/**
 * Restores a deleted account inside its recovery window, in one transaction. The account returns to the status it had before
 * (a suspended account stays suspended). Listings archived with it come back: drafts and listings under review as they were,
 * and live or suspended listings as suspended. The caller then re-runs the publish gate for the ones that were live.
 * Cancelled offers are not revived: both sides were told. Null when the account is not restorable now.
 */
export async function restoreAccountPg(
  db: Queryable, staff: { id: string; role: string }, userId: string, reason: string, now: string
): Promise<RestoreResult | null> {
  return inTx(db, async tx => {
    const done = (await tx.query(
      `UPDATE app_user SET status = status_before_delete, status_before_delete = NULL, deleted_at = NULL, restore_until = NULL, retain_until = NULL,
            restored_at = $2
        WHERE id = $1 AND deleted_at IS NOT NULL AND deactivated_at IS NULL AND restore_until > $2 RETURNING status`,
      [userId, now])).rows[0];
    if (!done) return null;

    const ev = (await tx.query(
      `SELECT payload->'listings' AS listings FROM audit_event
        WHERE aggregate_type = 'user' AND aggregate_id = $1 AND event_type = 'user.deleted' ORDER BY occurred_at DESC LIMIT 1`, [userId])).rows[0];
    const archived = Array.isArray(ev?.["listings"]) ? (ev["listings"] as unknown[]) : [];
    const listings: RestoreResult["listings"] = [];
    const correlationId = randomUUID();
    for (const item of archived) {
      const id = str((item as Record<string, unknown> | null)?.["id"]);
      const from = str((item as Record<string, unknown> | null)?.["from"]);
      if (!id || !from) continue;
      const to = from === "draft" || from === "pending_review" ? from : "suspended";
      const moved = await tx.query(
        `UPDATE property_listing SET status = $3, updated_at = $4 WHERE id = $1::uuid AND owner_user_id = $2 AND status = 'archived' RETURNING id`,
        [id, userId, to, now]);
      if (moved.rows.length === 0) continue;
      await appendAuditPg(tx, {
        id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "listing", aggregateId: id,
        eventType: `listing.${to}`, correlationId, payload: { from: "archived", to, role: staff.role, reason, restoredWithAccount: userId }
      });
      listings.push({ id, to, wasPublished: from === "published" });
    }
    await appendAuditPg(tx, {
      id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "user", aggregateId: userId,
      eventType: "user.restored", correlationId, payload: { role: staff.role, reason, status: String(done["status"]), listings }
    });
    return { status: String(done["status"]), listings };
  });
}

export interface DeletedAccountRow {
  id: string; name: string; email: string | null; userType: string; statusBefore: string | null;
  deletedAt: string; restoreUntil: string; retainUntil: string; deactivatedAt: string | null; purgedAt: string | null;
  deletedBy: string | null; reason: string | null; archivedListings: number; cancelledOffers: number; liveOffers: number;
}

/** Deleted accounts, most recently deleted first, paged (keyset). Who deleted it and why come from the account's deletion event. */
export async function listDeletedAccounts(db: Queryable, cursor?: string): Promise<{ rows: DeletedAccountRow[]; nextCursor: string | null }> {
  const cur = cursor ? decodeCursor(cursor) : null;
  const res = await db.query(
    `SELECT u.id, u.display_name, u.email::text AS email, u.user_type, u.status_before_delete, u.deleted_at, u.restore_until, u.retain_until,
            u.deactivated_at, u.personal_data_purged_at, d.reason, d.listings, d.offers, d.live, s.email::text AS deleted_by
       FROM app_user u
       LEFT JOIN LATERAL (
         SELECT e.actor_id, e.payload->>'reason' AS reason, jsonb_array_length(COALESCE(e.payload->'listings', '[]'::jsonb)) AS listings,
                jsonb_array_length(COALESCE(e.payload->'cancelledOffers', '[]'::jsonb)) AS offers, (e.payload->>'liveOffers')::int AS live
           FROM audit_event e
          WHERE e.aggregate_type = 'user' AND e.aggregate_id = u.id::text AND e.event_type = 'user.deleted'
          ORDER BY e.occurred_at DESC LIMIT 1
       ) d ON true
       LEFT JOIN app_user s ON s.id::text = d.actor_id
      WHERE u.deleted_at IS NOT NULL
        AND ($1::timestamptz IS NULL OR (u.deleted_at, u.id) < ($1::timestamptz, $2::uuid))
      ORDER BY u.deleted_at DESC, u.id DESC LIMIT $3`,
    [cur?.sortValue ?? null, cur?.id ?? null, PAGE + 1]
  );
  const rows = res.rows.slice(0, PAGE).map((r): DeletedAccountRow => ({
    id: String(r["id"]), name: String(r["display_name"] ?? ""), email: str(r["email"]), userType: String(r["user_type"]),
    statusBefore: str(r["status_before_delete"]), deletedAt: iso(r["deleted_at"]), restoreUntil: iso(r["restore_until"]),
    retainUntil: iso(r["retain_until"]), deactivatedAt: isoOrNull(r["deactivated_at"]), purgedAt: isoOrNull(r["personal_data_purged_at"]),
    deletedBy: str(r["deleted_by"]), reason: str(r["reason"]),
    archivedListings: n(r["listings"]), cancelledOffers: n(r["offers"]), liveOffers: n(r["live"])
  }));
  const last = rows[rows.length - 1];
  return { rows, nextCursor: res.rows.length > PAGE && last ? encodeCursor({ sortValue: last.deletedAt, id: last.id }) : null };
}

/**
 * The scheduled retention step. First, deletions whose recovery window has passed become final (no restore from then on). Then,
 * accounts past their retention period lose their name, email, Google link and phone number; the anonymous records (offers,
 * invoices, audit history) stay. Each account changed gets its own audit event. Safe to run any number of times.
 */
export async function runAccountRetention(db: Queryable, now: string): Promise<{ finalised: number; purged: number }> {
  return inTx(db, async tx => {
    const finalised = (await tx.query(
      `UPDATE app_user SET deactivated_at = $1
        WHERE deleted_at IS NOT NULL AND deactivated_at IS NULL AND restore_until <= $1 RETURNING id`, [now])).rows.map(r => String(r["id"]));
    const purged = (await tx.query(
      `UPDATE app_user SET email = NULL, display_name = 'Deleted account', google_sub = NULL, personal_data_purged_at = $1
        WHERE deactivated_at IS NOT NULL AND retain_until <= $1 AND personal_data_purged_at IS NULL RETURNING id`, [now])).rows.map(r => String(r["id"]));
    if (purged.length > 0) await tx.query("UPDATE buyer_verification SET phone_e164 = NULL WHERE user_id = ANY($1::uuid[])", [purged]);
    const correlationId = randomUUID();
    const log = (id: string, eventType: string) => appendAuditPg(tx, {
      id: randomUUID(), occurredAt: now, actorType: "system", actorId: "account-retention", aggregateType: "user", aggregateId: id,
      eventType, correlationId, payload: {}
    });
    for (const id of finalised) await log(id, "user.deletion_final");
    for (const id of purged) await log(id, "user.personal_data_purged");
    return { finalised: finalised.length, purged: purged.length };
  });
}
