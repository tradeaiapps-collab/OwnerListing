import { randomUUID } from "node:crypto";
import { BOOKING_LIMITS, BOOKING_TRANSITIONS, documentUrl, type BookingRow, type ClientPortalRepository, type OfferForPdf, type PortalDocument } from "../domain/client-portal";
import { getDb } from "./context";
import type { Queryable } from "./db";
import { createPgInspectionRepository } from "./inspection-db";

// Constant SQL text; every value is a bound parameter and every read is scoped by the signed-in user's id (never an id from the request alone).
// Bookings are never deleted (the table refuses it). Each write is ONE statement that also inserts its audit_event row.

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** True when $n owns the listing (`l`) or is its appointed agent with full scope. */
const managerOf = (n: number) =>
  `(l.owner_user_id = $${n}::uuid OR EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.listing_id = l.id AND a.agent_user_id = $${n}::uuid AND a.revoked_at IS NULL AND a.scope = 'full'))`;

/** Params: 1 user. Offers the user made, or on a listing they own. */
export const OFFER_DOCS_SQL =
  "SELECT o.id, o.status, o.submitted_at, l.id AS listing_id, l.title FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id " +
  "WHERE o.buyer_user_id = $1::uuid OR l.owner_user_id = $1::uuid ORDER BY o.submitted_at DESC, o.id LIMIT 200";

/** Params: 1 user. Finished signing documents the user signed or owns the listing of. */
export const SIGNED_DOCS_SQL =
  "SELECT d.id, d.title, d.closed_at, d.created_at, l.id AS listing_id, l.title AS listing_title FROM signing_document d JOIN property_listing l ON l.id = d.listing_id " +
  "WHERE d.status = 'completed' AND (l.owner_user_id = $1::uuid OR EXISTS (SELECT 1 FROM signing_signer s WHERE s.document_id = d.id AND s.user_id = $1::uuid)) " +
  "ORDER BY d.closed_at DESC NULLS LAST, d.id LIMIT 200";

/** Params: 1 offer, 2 user. No row unless the user made the offer or owns its listing. */
export const OFFER_FOR_SQL =
  "SELECT o.id, o.price_cents, o.deposit_cents, o.settlement_days, o.conditions, o.status, o.submitted_at, o.buyer_user_id, l.title, l.address_text, bu.display_name AS buyer_name " +
  "FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id JOIN app_user bu ON bu.id = o.buyer_user_id " +
  "WHERE o.id = $1::uuid AND (o.buyer_user_id = $2::uuid OR l.owner_user_id = $2::uuid)";

export const OFFER_EVENTS_SQL = "SELECT event_type, occurred_at, price_cents FROM offer_event WHERE offer_id = $1::uuid ORDER BY occurred_at, id";

/** Params: 1 user. Requests the user made and requests on listings they manage. */
export const BOOKINGS_SQL =
  "SELECT b.id, b.listing_id, l.title, b.kind, b.starts_at, b.note, b.status, " +
  "CASE WHEN b.requester_user_id = $1::uuid THEN 'requester' ELSE 'manager' END AS role, " +
  "CASE WHEN b.requester_user_id = $1::uuid THEN ou.display_name ELSE ru.display_name END AS other_name " +
  "FROM viewing_booking b JOIN property_listing l ON l.id = b.listing_id JOIN app_user ru ON ru.id = b.requester_user_id JOIN app_user ou ON ou.id = l.owner_user_id " +
  "WHERE b.requester_user_id = $1::uuid OR " + managerOf(1) + " ORDER BY b.starts_at DESC, b.id LIMIT 200";

const auditTail = (n: number, actor: number) =>
  `INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) ` +
  `SELECT $${n}::uuid, now(), 'user', $${actor}::text, 'viewing_booking', done.aggregate_id, $${n + 1}::text, $${n + 2}::text, $${n + 3}::jsonb FROM done RETURNING aggregate_id`;

/** Params: 1 id, 2 listing, 3 requester, 4 kind, 5 start, 6 note, 7 open cap, 8..11 audit. Only a published listing the requester does not own. */
export const CREATE_BOOKING_SQL =
  "WITH cnt AS (SELECT count(*) AS n FROM viewing_booking WHERE requester_user_id = $3::uuid AND status IN ('requested','confirmed') AND starts_at > now()), " +
  "done AS (INSERT INTO viewing_booking (id, listing_id, requester_user_id, kind, starts_at, note) " +
  "SELECT $1::uuid, l.id, $3::uuid, $4::text, $5::timestamptz, $6::text FROM property_listing l, cnt " +
  "WHERE l.id = $2::uuid AND l.status = 'published' AND l.owner_user_id <> $3::uuid AND cnt.n < $7::int " +
  "ON CONFLICT (listing_id, requester_user_id, kind, starts_at) WHERE status IN ('requested','confirmed') DO NOTHING RETURNING id::text AS aggregate_id) " + auditTail(8, 3);

/** Params: 1 id, 2 user, 3 side, 4 allowed from-statuses, 5 to-status, 6..9 audit. */
export const TRANSITION_BOOKING_SQL =
  "WITH done AS (UPDATE viewing_booking b SET status = $5::text, decided_by = $2::uuid, decided_at = now() FROM property_listing l " +
  "WHERE b.id = $1::uuid AND l.id = b.listing_id AND b.status = ANY($4::text[]) " +
  `AND (($3::text = 'requester' AND b.requester_user_id = $2::uuid) OR ($3::text = 'manager' AND b.requester_user_id <> $2::uuid AND ${managerOf(2)})) RETURNING b.id::text AS aggregate_id) ` + auditTail(6, 2);

export function createPgClientPortalRepository(db: Queryable): ClientPortalRepository {
  return {
    async documentsFor(userId) {
      const docs: PortalDocument[] = [];
      for (const r of (await db.query(OFFER_DOCS_SQL, [userId])).rows) {
        docs.push({ kind: "offer", id: String(r["id"]), title: "Offer summary", listingId: String(r["listing_id"]), listingTitle: String(r["title"]), at: iso(r["submitted_at"]), status: String(r["status"]), downloadUrl: documentUrl("offer", String(r["id"])) });
      }
      for (const r of (await db.query(SIGNED_DOCS_SQL, [userId])).rows) {
        docs.push({ kind: "signed", id: String(r["id"]), title: String(r["title"]), listingId: String(r["listing_id"]), listingTitle: String(r["listing_title"]), at: iso(r["closed_at"] ?? r["created_at"]), status: "completed", downloadUrl: documentUrl("signed", String(r["id"])) });
      }
      // Same visibility rules as the inspection pages: managers, the inspector, and viewers it was shared with (completed reports only).
      for (const i of await createPgInspectionRepository(db).listFor(userId)) {
        if (i.status !== "completed") continue;
        docs.push({ kind: "inspection", id: i.id, title: "Inspection report", listingId: i.listingId, listingTitle: i.listingTitle, at: i.scheduledAt, status: i.status, downloadUrl: documentUrl("inspection", i.id) });
      }
      return docs;
    },
    async offerFor(userId, offerId) {
      const r = (await db.query(OFFER_FOR_SQL, [offerId, userId])).rows[0];
      if (!r) return undefined;
      const viewer: OfferForPdf["viewer"] = String(r["buyer_user_id"]) === userId ? "buyer" : "owner";
      const events = (await db.query(OFFER_EVENTS_SQL, [offerId])).rows;
      return {
        id: String(r["id"]), listingTitle: String(r["title"]), address: String(r["address_text"]), priceCents: Number(r["price_cents"]), depositCents: Number(r["deposit_cents"]),
        settlementDays: Number(r["settlement_days"]), conditions: Array.isArray(r["conditions"]) ? (r["conditions"] as unknown[]).map(String) : [], status: String(r["status"]),
        submittedAt: iso(r["submitted_at"]), viewer, ...(viewer === "buyer" ? { buyerName: String(r["buyer_name"]) } : {}),
        events: events.map(e => ({ type: String(e["event_type"]), at: iso(e["occurred_at"]), ...(e["price_cents"] != null ? { priceCents: Number(e["price_cents"]) } : {}) }))
      };
    },
    async bookingsFor(userId) {
      return (await db.query(BOOKINGS_SQL, [userId])).rows.map((r): BookingRow => ({
        id: String(r["id"]), listingId: String(r["listing_id"]), listingTitle: String(r["title"]), kind: r["kind"] as BookingRow["kind"], startsAt: iso(r["starts_at"]),
        note: String(r["note"]), status: r["status"] as BookingRow["status"], role: r["role"] as BookingRow["role"], otherPartyName: String(r["other_name"])
      }));
    },
    async createBooking(userId, b, id, correlationId) {
      const rows = (await db.query(CREATE_BOOKING_SQL, [id, b.listingId, userId, b.kind, b.startsAt, b.note, BOOKING_LIMITS.maxOpenPerUser, randomUUID(), "booking.requested", correlationId, JSON.stringify({ kind: b.kind, startsAt: b.startsAt })])).rows;
      if (rows.length > 0) return "created";
      const open = Number((await db.query("SELECT count(*) AS n FROM viewing_booking WHERE requester_user_id = $1::uuid AND status IN ('requested','confirmed') AND starts_at > now()", [userId])).rows[0]?.["n"]);
      if (open >= BOOKING_LIMITS.maxOpenPerUser) return "too_many";
      const ok = (await db.query("SELECT 1 FROM property_listing WHERE id = $1::uuid AND status = 'published' AND owner_user_id <> $2::uuid", [b.listingId, userId])).rows.length > 0;
      return ok ? "duplicate" : "not_bookable";
    },
    async transitionBooking(userId, bookingId, action, correlationId) {
      const t = BOOKING_TRANSITIONS[action];
      const rows = (await db.query(TRANSITION_BOOKING_SQL, [bookingId, userId, t.side, t.from, t.to, randomUUID(), `booking.${t.to}`, correlationId, JSON.stringify({ action })])).rows;
      return rows.length > 0;
    }
  };
}

export const getClientPortalRepo = () => createPgClientPortalRepository(getDb());
export const portalIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
