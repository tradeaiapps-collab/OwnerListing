import { randomUUID } from "node:crypto";
import type { AuditEvent } from "../domain/audit";
import type {
  Booking, BookingRepository, BookingStatus, InspectorProfile, InspectorStatus, Jurisdiction, OpenRequest, StaffBookingRow
} from "../domain/inspection-marketplace";
import { areaOnly } from "../domain/contractor-trust";
import { getBuyerVerification } from "./enquiry-db";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Constant SQL text: user input only travels as bound parameters; the acting user id comes from the session.
// Each write is ONE statement that also inserts its audit_event row, so a change and its audit record succeed or fail together.

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const auditParams = (e: AuditEvent) => [e.id, e.occurredAt, e.eventType, e.correlationId, JSON.stringify(e.payload)];

/** Audit insert reading the single row the guarded statement returned. Params n..n+4: id, at, event type, correlation, payload. */
const auditTail = (n: number, actor: number, aggregateType: string, aggregate: string) =>
  `INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) ` +
  `SELECT $${n}::uuid, $${n + 1}::timestamptz, 'user', $${actor}::text, '${aggregateType}', ${aggregate}, $${n + 2}::text, $${n + 3}::text, $${n + 4}::jsonb FROM done RETURNING aggregate_id`;

export const BOOKABLE_LISTING_SQL =
  "SELECT l.id, l.title, l.jurisdiction FROM property_listing l WHERE l.id = $1::uuid AND l.status = 'published' AND l.owner_user_id <> $2::uuid";

/** Params: 1 id, 2 listing, 3 buyer, 4 slots, 5 notes, 6..10 audit. The open-request index turns a repeat into zero rows. */
export const INSERT_BOOKING_SQL =
  "WITH done AS (INSERT INTO inspection_booking (id, listing_id, buyer_id, slots, notes) " +
  "SELECT $1::uuid, l.id, $3::uuid, $4::jsonb, $5::text FROM property_listing l WHERE l.id = $2::uuid AND l.status = 'published' AND l.owner_user_id <> $3::uuid " +
  "ON CONFLICT DO NOTHING RETURNING id::text AS aggregate_id) " + auditTail(6, 3, "inspection_booking", "done.aggregate_id");

const BOOKING_COLUMNS =
  "b.id, b.listing_id, l.title, b.buyer_id, b.slots, b.notes, b.inspection_id, b.scheduled_at, b.created_at, iu.display_name AS inspector_name, b.inspector_user_id, " +
  "CASE WHEN b.status = 'scheduled' AND i.status = 'completed' THEN 'completed' ELSE b.status END AS status";
const BOOKING_FROM =
  "FROM inspection_booking b JOIN property_listing l ON l.id = b.listing_id LEFT JOIN inspection i ON i.id = b.inspection_id LEFT JOIN app_user iu ON iu.id = b.inspector_user_id";

export const BUYER_BOOKINGS_SQL = `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM} WHERE b.buyer_id = $1::uuid ORDER BY b.created_at DESC, b.id LIMIT 100`;
export const INSPECTOR_BOOKINGS_SQL = `SELECT ${BOOKING_COLUMNS} ${BOOKING_FROM} WHERE b.inspector_user_id = $1::uuid ORDER BY b.scheduled_at DESC, b.id LIMIT 100`;
export const STAFF_BOOKINGS_SQL =
  `SELECT * FROM (SELECT ${BOOKING_COLUMNS}, bu.display_name AS buyer_name ${BOOKING_FROM} JOIN app_user bu ON bu.id = b.buyer_id) x ` +
  "WHERE ($1::text IS NULL OR x.status = $1::text) ORDER BY x.created_at DESC, x.id LIMIT 200";

/** Params: 1 booking, 2 buyer, 3 at, 4..8 audit. A booking whose inspection is finished cannot be cancelled; an accepted inspection is cancelled with it. */
export const CANCEL_BOOKING_SQL =
  "WITH b AS (UPDATE inspection_booking b SET status = 'cancelled', cancelled_at = $3::timestamptz WHERE b.id = $1::uuid AND b.buyer_id = $2::uuid " +
  "AND b.status IN ('pending_inspector_response', 'scheduled') AND NOT EXISTS (SELECT 1 FROM inspection i WHERE i.id = b.inspection_id AND i.status = 'completed') " +
  "RETURNING b.id, b.inspection_id), " +
  "i AS (UPDATE inspection SET status = 'cancelled' WHERE id IN (SELECT inspection_id FROM b) AND status IN ('invited', 'accepted') RETURNING id), " +
  "done AS (SELECT id::text AS aggregate_id FROM b) " + auditTail(4, 2, "inspection_booking", "done.aggregate_id");

export const PROFILE_SQL =
  "SELECT user_id, business_name, licence_ref, jurisdictions, status, review_note, created_at FROM inspector_profile WHERE user_id = $1::uuid";

/** Params: 1 user, 2 business, 3 licence, 4 states, 5 user type, 6..10 audit. Only vendor or agent accounts that are not closed; an edit puts a rejected profile back to pending. */
export const UPSERT_PROFILE_SQL =
  "WITH done AS (INSERT INTO inspector_profile (user_id, business_name, licence_ref, jurisdictions) " +
  "SELECT u.id, $2::text, $3::text, $4::text[] FROM app_user u WHERE u.id = $1::uuid AND u.user_type = $5::text AND u.user_type IN ('vendor', 'agent') AND u.status NOT IN ('suspended', 'closed') " +
  "ON CONFLICT (user_id) DO UPDATE SET business_name = EXCLUDED.business_name, licence_ref = EXCLUDED.licence_ref, jurisdictions = EXCLUDED.jurisdictions, status = 'pending', review_note = '' " +
  "WHERE inspector_profile.status IN ('pending', 'rejected') RETURNING user_id::text AS aggregate_id) " + auditTail(6, 1, "inspector_profile", "done.aggregate_id");

/** Params: 1 inspector. Pending requests in the inspector's states that they have not passed on, never their own listing or own request. */
export const OPEN_REQUESTS_SQL =
  "SELECT b.id, b.listing_id, l.title, l.suburb, l.postcode, l.jurisdiction, b.slots, b.notes, b.created_at FROM inspection_booking b " +
  "JOIN property_listing l ON l.id = b.listing_id JOIN inspector_profile p ON p.user_id = $1::uuid AND p.status = 'approved' AND l.jurisdiction = ANY(p.jurisdictions) " +
  "WHERE b.status = 'pending_inspector_response' AND l.status = 'published' AND l.owner_user_id <> $1::uuid AND b.buyer_id <> $1::uuid " +
  "AND NOT EXISTS (SELECT 1 FROM contractor_standing cs WHERE cs.user_id = $1::uuid AND cs.suspended) " +
  "AND NOT EXISTS (SELECT 1 FROM inspection_booking_pass x WHERE x.booking_id = b.id AND x.inspector_user_id = $1::uuid) " +
  "ORDER BY b.created_at, b.id LIMIT 100";

/**
 * Params: 1 booking, 2 inspector, 3 chosen slot, 4 new inspection id, 5..9 audit. First accept wins: the booking update only matches while pending.
 * The inspection starts as 'accepted' (the report workflow takes over) and the buyer gets a share so they see the finished report.
 */
export const ACCEPT_SQL =
  "WITH b AS (UPDATE inspection_booking b SET status = 'scheduled', inspection_id = $4::uuid, inspector_user_id = $2::uuid, scheduled_at = $3::timestamptz " +
  "FROM property_listing l, inspector_profile p WHERE b.id = $1::uuid AND b.status = 'pending_inspector_response' AND l.id = b.listing_id AND l.status = 'published' " +
  "AND NOT EXISTS (SELECT 1 FROM contractor_standing cs WHERE cs.user_id = $2::uuid AND cs.suspended) " +
  "AND l.owner_user_id <> $2::uuid AND b.buyer_id <> $2::uuid AND p.user_id = $2::uuid AND p.status = 'approved' AND l.jurisdiction = ANY(p.jurisdictions) " +
  "AND b.slots @> to_jsonb($3::text) AND $3::timestamptz > now() " +
  "AND NOT EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $2::uuid AND a.revoked_at IS NULL) " +
  "RETURNING b.id, b.listing_id, b.buyer_id, b.notes), " +
  "i AS (INSERT INTO inspection (id, listing_id, requested_by, inspector_user_id, inspection_type, scheduled_at, notes, status) " +
  "SELECT $4::uuid, listing_id, buyer_id, $2::uuid, 'pre_purchase', $3::timestamptz, notes, 'accepted' FROM b RETURNING id, requested_by), " +
  "s AS (INSERT INTO inspection_share (inspection_id, shared_with_user_id, shared_by) SELECT id, requested_by, $2::uuid FROM i RETURNING inspection_id), " +
  "done AS (SELECT b.id::text AS aggregate_id FROM b JOIN i ON true JOIN s ON true) " + auditTail(5, 2, "inspection_booking", "done.aggregate_id");

/** Params: 1 booking, 2 inspector, 3..7 audit. Only an approved inspector who could have accepted it; hides it from them only. */
export const PASS_SQL =
  "WITH done AS (INSERT INTO inspection_booking_pass (booking_id, inspector_user_id) SELECT b.id, $2::uuid FROM inspection_booking b " +
  "JOIN property_listing l ON l.id = b.listing_id JOIN inspector_profile p ON p.user_id = $2::uuid AND p.status = 'approved' AND l.jurisdiction = ANY(p.jurisdictions) " +
  "WHERE b.id = $1::uuid AND b.status = 'pending_inspector_response' ON CONFLICT DO NOTHING RETURNING booking_id::text AS aggregate_id) " + auditTail(3, 2, "inspection_booking", "done.aggregate_id");

export const LIST_PROFILES_SQL =
  "SELECT p.user_id, p.business_name, p.licence_ref, p.jurisdictions, p.status, p.review_note, p.created_at, u.display_name, u.email FROM inspector_profile p " +
  "JOIN app_user u ON u.id = p.user_id WHERE ($1::text IS NULL OR p.status = $1::text) ORDER BY (p.status = 'pending') DESC, p.created_at DESC LIMIT 200";

/** Params: 1 inspector, 2 new status, 3 note, 4 staff, 5 allowed from-statuses, 6..10 audit. */
export const REVIEW_PROFILE_SQL =
  "WITH done AS (UPDATE inspector_profile SET status = $2::text, review_note = $3::text, reviewed_by = $4::uuid, reviewed_at = now() " +
  "WHERE user_id = $1::uuid AND status = ANY($5::text[]) RETURNING user_id::text AS aggregate_id) " + auditTail(6, 4, "inspector_profile", "done.aggregate_id");

const slotsOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function toBooking(r: Record<string, unknown>): Booking {
  return {
    id: text(r["id"]), listingId: text(r["listing_id"]), listingTitle: text(r["title"]), buyerId: text(r["buyer_id"]), slots: slotsOf(r["slots"]), notes: text(r["notes"]),
    status: r["status"] as BookingStatus, createdAt: iso(r["created_at"]),
    ...(r["inspection_id"] ? { inspectionId: text(r["inspection_id"]) } : {}),
    ...(r["inspector_name"] ? { inspectorName: text(r["inspector_name"]) } : {}),
    ...(r["scheduled_at"] ? { scheduledAt: iso(r["scheduled_at"]) } : {})
  };
}
const toProfile = (r: Record<string, unknown>): InspectorProfile => ({
  userId: text(r["user_id"]), businessName: text(r["business_name"]), licenceRef: text(r["licence_ref"]), jurisdictions: (r["jurisdictions"] as string[]).map(String) as Jurisdiction[],
  status: r["status"] as InspectorStatus, reviewNote: text(r["review_note"]), createdAt: iso(r["created_at"])
});

export function createPgBookingRepository(db: Queryable): BookingRepository {
  return {
    async bookableListing(listingId, buyerId) {
      const r = (await db.query(BOOKABLE_LISTING_SQL, [listingId, buyerId])).rows[0];
      return r ? { id: text(r["id"]), title: text(r["title"]), jurisdiction: text(r["jurisdiction"]) as Jurisdiction } : undefined;
    },
    buyerVerification: userId => getBuyerVerification(db, userId),
    async insertBooking(b, a) {
      return (await db.query(INSERT_BOOKING_SQL, [b.id, b.listingId, b.buyerId, JSON.stringify(b.slots), b.notes, ...auditParams(a)])).rows.length === 1;
    },
    async bookingsForBuyer(userId) { return (await db.query(BUYER_BOOKINGS_SQL, [userId])).rows.map(toBooking); },
    async cancelBooking(id, buyerId, at, a) { return (await db.query(CANCEL_BOOKING_SQL, [id, buyerId, at, ...auditParams(a)])).rows.length === 1; },
    async profile(userId) {
      const r = (await db.query(PROFILE_SQL, [userId])).rows[0];
      return r ? toProfile(r) : undefined;
    },
    async upsertProfile(p, userType, a) {
      return (await db.query(UPSERT_PROFILE_SQL, [p.userId, p.businessName, p.licenceRef, p.jurisdictions, userType, ...auditParams(a)])).rows.length === 1;
    },
    async openRequests(inspectorId) {
      const now = Date.now();
      return (await db.query(OPEN_REQUESTS_SQL, [inspectorId])).rows
        .map((r): OpenRequest => ({
          id: text(r["id"]), listingId: text(r["listing_id"]), listingTitle: text(r["title"]), area: areaOnly({ suburb: r["suburb"] === null ? null : text(r["suburb"]), postcode: r["postcode"] === null ? null : text(r["postcode"]), jurisdiction: text(r["jurisdiction"]) }), jurisdiction: text(r["jurisdiction"]) as Jurisdiction,
          slots: slotsOf(r["slots"]).filter(s => Date.parse(s) > now), notes: text(r["notes"]), createdAt: iso(r["created_at"])
        }))
        .filter(r => r.slots.length > 0);
    },
    async bookingsForInspector(inspectorId) { return (await db.query(INSPECTOR_BOOKINGS_SQL, [inspectorId])).rows.map(toBooking); },
    async accept(bookingId, inspectorId, slot, inspectionId, a) {
      return (await db.query(ACCEPT_SQL, [bookingId, inspectorId, slot, inspectionId, ...auditParams(a)])).rows.length === 1;
    },
    async pass(bookingId, inspectorId, a) { return (await db.query(PASS_SQL, [bookingId, inspectorId, ...auditParams(a)])).rows.length === 1; },
    async listProfiles(status) {
      return (await db.query(LIST_PROFILES_SQL, [status ?? null])).rows.map(r => ({ ...toProfile(r), name: text(r["display_name"]), email: text(r["email"]) }));
    },
    async reviewProfile(userId, status, note, staffId, from, a) {
      return (await db.query(REVIEW_PROFILE_SQL, [userId, status, note, staffId, from, ...auditParams(a)])).rows.length === 1;
    },
    async listBookings(status) {
      return (await db.query(STAFF_BOOKINGS_SQL, [status ?? null])).rows.map((r): StaffBookingRow => ({
        ...toBooking(r), buyerName: text(r["buyer_name"]), ...(r["inspector_user_id"] ? { inspectorUserId: text(r["inspector_user_id"]) } : {})
      }));
    }
  };
}

export const getBookingRepo = () => createPgBookingRepository(getDb());
export const bookingIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
