import { notSuspendedSql } from "./contractor-standing-sql";
import { isTrade, type EmergencyCandidate, type EmergencyProfile, type EmergencyRequestInput, type EmergencyTrade, type HoursWindow } from "../domain/emergency";
import type { Queryable } from "./db";

// Constant SQL text; input only as bound parameters. User ids come from the session, never from the request body.
const OPEN_HOURS = 6;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const iso = (v: unknown) => new Date(v as string).toISOString();

const toProfile = (r: Record<string, unknown>): EmergencyProfile => ({
  trade: r["trade"] as EmergencyTrade, enabled: r["enabled"] === true, timeZone: String(r["time_zone"]), allHours: r["all_hours"] === true,
  windows: (Array.isArray(r["windows"]) ? r["windows"] : []) as HoursWindow[],
  callOutCents: r["call_out_cents"] === null || r["call_out_cents"] === undefined ? null : Number(r["call_out_cents"]),
  businessName: str(r["business_name"]), contactPhone: String(r["contact_phone"]), contactEmail: str(r["contact_email"]), note: str(r["note"]),
  serviceSuburbs: arr(r["service_suburbs"]), servicePostcodes: arr(r["service_postcodes"])
});

export const PROFILES_SQL =
  "SELECT trade, enabled, time_zone, all_hours, windows, call_out_cents, business_name, contact_phone, contact_email, note, service_suburbs, service_postcodes " +
  "FROM emergency_contractor WHERE user_id = $1::uuid ORDER BY trade";
export const SAVE_PROFILE_SQL =
  "INSERT INTO emergency_contractor (user_id, trade, enabled, time_zone, all_hours, windows, call_out_cents, business_name, contact_phone, contact_email, note, service_suburbs, service_postcodes, updated_at) " +
  "VALUES ($1::uuid, $2::text, $3, $4::text, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::text[], $13::text[], now()) " +
  "ON CONFLICT (user_id, trade) DO UPDATE SET enabled = EXCLUDED.enabled, time_zone = EXCLUDED.time_zone, all_hours = EXCLUDED.all_hours, windows = EXCLUDED.windows, " +
  "call_out_cents = EXCLUDED.call_out_cents, business_name = EXCLUDED.business_name, contact_phone = EXCLUDED.contact_phone, contact_email = EXCLUDED.contact_email, " +
  "note = EXCLUDED.note, service_suburbs = EXCLUDED.service_suburbs, service_postcodes = EXCLUDED.service_postcodes, updated_at = now()";
export const CANDIDATES_SQL =
  "SELECT u.id, u.display_name, e.trade, e.enabled, e.time_zone, e.all_hours, e.windows, e.call_out_cents, e.business_name, e.contact_phone, e.contact_email, e.note, e.service_suburbs, e.service_postcodes, " +
  "(SELECT count(*) FROM emergency_request_contact c WHERE c.contractor_user_id = u.id AND c.sent_at > now() - interval '1 day')::int AS messages_today " +
  "FROM emergency_contractor e JOIN app_user u ON u.id = e.user_id " +
  "WHERE e.enabled AND ($1::text IS NULL OR e.trade = $1::text) AND u.status NOT IN ('suspended','closed') AND u.deleted_at IS NULL AND u.user_type = 'vendor' AND " + notSuspendedSql("u.id") + " ORDER BY u.id LIMIT 2000";

export async function getProfilesPg(db: Queryable, userId: string): Promise<EmergencyProfile[]> {
  return (await db.query(PROFILES_SQL, [userId])).rows.map(toProfile);
}
export async function saveProfilePg(db: Queryable, userId: string, p: EmergencyProfile): Promise<void> {
  await db.query(SAVE_PROFILE_SQL, [userId, p.trade, p.enabled, p.timeZone, p.allHours, JSON.stringify(p.windows), p.callOutCents, p.businessName, p.contactPhone, p.contactEmail, p.note, p.serviceSuburbs, p.servicePostcodes]);
}
export async function candidatesPg(db: Queryable, trade?: EmergencyTrade): Promise<EmergencyCandidate[]> {
  const { rows } = await db.query(CANDIDATES_SQL, [trade ?? null]);
  return rows.map(r => ({ userId: String(r["id"]), displayName: String(r["display_name"]), profile: toProfile(r), messagesToday: Number(r["messages_today"]) }));
}

export async function recentRequestTimesPg(db: Queryable, userId: string): Promise<string[]> {
  const r = await db.query("SELECT created_at FROM emergency_request WHERE requester_user_id = $1::uuid AND created_at > now() - interval '1 day'", [userId]);
  return r.rows.map(x => iso(x["created_at"]));
}

/** The requester's own listing, for the address the request is about. Undefined if it is not theirs. */
export async function ownListingPg(db: Queryable, listingId: string, userId: string): Promise<{ addressText: string; suburb: string | null; postcode: string | null; propertyKind: "sale" | "rental" } | undefined> {
  const r = (await db.query("SELECT address_text, suburb, postcode, transaction_type FROM property_listing WHERE id = $1::uuid AND owner_user_id = $2::uuid", [listingId, userId])).rows[0];
  return r ? { addressText: String(r["address_text"]), suburb: str(r["suburb"]), postcode: str(r["postcode"]), propertyKind: r["transaction_type"] === "rent" ? "rental" : "sale" } : undefined;
}

export async function createRequestPg(db: Queryable, requesterId: string, i: EmergencyRequestInput): Promise<{ id: string; number: number }> {
  const r = (await db.query(
    "INSERT INTO emergency_request (requester_user_id, listing_id, property_kind, trade, description, address_text, suburb, postcode, callback_phone) " +
    "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9) RETURNING id, number",
    [requesterId, i.listingId, i.propertyKind, i.trade, i.description, i.addressText, i.suburb, i.postcode, i.callbackPhone])).rows[0]!;
  return { id: String(r["id"]), number: Number(r["number"]) };
}
export async function addContactPg(db: Queryable, requestId: string, contractorId: string, d: { email: "sent" | "failed" | "skipped"; sms: "sent" | "failed" | "skipped" }): Promise<void> {
  // Always "sent": the request is on the contractor's emergency page whatever happened to the email or text, which are recorded beside it.
  await db.query(
    "INSERT INTO emergency_request_contact (request_id, contractor_user_id, status, email_status, sms_status) VALUES ($1::uuid, $2::uuid, 'sent', $3, $4) ON CONFLICT DO NOTHING",
    [requestId, contractorId, d.email, d.sms]);
}

export interface ContactView { contractorName: string; businessName: string | null; status: string; etaMinutes: number | null; note: string | null; repliedAt: string | null; phone: string | null; email: string | null }
export interface RequestView {
  id: string; number: number; role: "requester" | "contractor"; status: "open" | "accepted" | "cancelled" | "expired";
  trade: EmergencyTrade; description: string; propertyKind: string; suburb: string | null; postcode: string | null; createdAt: string;
  /** Set once a contractor accepts: the JOB- number, and the job screen when the request was about one of the requester's listings. */
  jobNumber: number | null; assignmentId: string | null; round: number;
  requesterName: string; addressText: string | null; callbackPhone: string | null; myStatus: string | null; replies: ContactView[];
}

const STATUS_EXPR = `CASE WHEN r.status = 'open' AND r.created_at <= now() - interval '${OPEN_HOURS} hours' THEN 'expired' ELSE r.status END`;
export const REQUESTS_SQL =
  `SELECT r.id, r.number, r.requester_user_id, ${STATUS_EXPR} AS status, r.trade, r.description, r.property_kind, r.suburb, r.postcode, r.created_at, r.address_text, r.callback_phone, ` +
  "r.accepted_contractor_user_id, r.job_number, r.assignment_id, r.round, u.display_name AS requester_name, mc.status AS my_status " +
  "FROM emergency_request r JOIN app_user u ON u.id = r.requester_user_id " +
  "LEFT JOIN emergency_request_contact mc ON mc.request_id = r.id AND mc.contractor_user_id = $1::uuid " +
  "WHERE (r.requester_user_id = $1::uuid OR mc.contractor_user_id IS NOT NULL) AND ($2::uuid IS NULL OR r.id = $2::uuid) ORDER BY r.created_at DESC LIMIT 50";
export const REPLIES_SQL =
  "SELECT c.request_id, c.status, c.note, c.eta_minutes, c.replied_at, u.display_name, u.email, e.business_name, e.contact_phone, e.contact_email " +
  "FROM emergency_request_contact c JOIN app_user u ON u.id = c.contractor_user_id JOIN emergency_request r ON r.id = c.request_id " +
  "LEFT JOIN emergency_contractor e ON e.user_id = c.contractor_user_id AND e.trade = r.trade " +
  "WHERE c.request_id = ANY($1::uuid[]) ORDER BY c.sent_at, c.contractor_user_id";

/** The signed-in user's requests (as requester) and the ones sent to them (as contractor). The street address and callback number reach a contractor only after they accept; a contractor's contact details reach the requester only after they accept. */
export async function listRequestsPg(db: Queryable, userId: string, id?: string): Promise<RequestView[]> {
  const rows = (await db.query(REQUESTS_SQL, [userId, id ?? null])).rows;
  const mine = rows.filter(r => String(r["requester_user_id"]) === userId).map(r => String(r["id"]));
  const replies = mine.length ? (await db.query(REPLIES_SQL, [mine])).rows : [];
  return rows.map((r): RequestView => {
    const requester = String(r["requester_user_id"]) === userId;
    const accepted = String(r["accepted_contractor_user_id"] ?? "") === userId;
    return {
      id: String(r["id"]), number: Number(r["number"]), role: requester ? "requester" : "contractor", status: r["status"] as RequestView["status"],
      trade: isTrade(r["trade"]) ? r["trade"] : "plumber", description: String(r["description"]), propertyKind: String(r["property_kind"]),
      suburb: str(r["suburb"]), postcode: str(r["postcode"]), createdAt: iso(r["created_at"]),
      jobNumber: r["job_number"] === null || r["job_number"] === undefined ? null : Number(r["job_number"]), assignmentId: str(r["assignment_id"]), round: Number(r["round"]),
      requesterName: String(r["requester_name"]).split(" ")[0] ?? "Customer",
      addressText: requester || accepted ? String(r["address_text"]) : null, callbackPhone: requester || accepted ? str(r["callback_phone"]) : null,
      myStatus: requester ? null : str(r["my_status"]),
      replies: requester ? replies.filter(c => String(c["request_id"]) === String(r["id"])).map((c): ContactView => {
        const ok = c["status"] === "accepted";
        return {
          contractorName: String(c["display_name"]), businessName: str(c["business_name"]), status: String(c["status"]),
          etaMinutes: c["eta_minutes"] === null ? null : Number(c["eta_minutes"]), note: str(c["note"]), repliedAt: c["replied_at"] ? iso(c["replied_at"]) : null,
          phone: ok ? str(c["contact_phone"]) : null, email: ok ? (str(c["contact_email"]) ?? str(c["email"])) : null
        };
      }) : []
    };
  });
}

export const ACCEPT_SQL =
  "WITH req AS (UPDATE emergency_request r SET status = 'accepted', accepted_contractor_user_id = $2::uuid, accepted_at = now() " +
  `WHERE r.id = $1::uuid AND r.status = 'open' AND r.created_at > now() - interval '${OPEN_HOURS} hours' ` +
  "AND " + notSuspendedSql("$2::uuid") + " " +
  "AND EXISTS (SELECT 1 FROM emergency_request_contact c WHERE c.request_id = r.id AND c.contractor_user_id = $2::uuid AND c.status = 'sent') " +
  "RETURNING r.id, r.number, r.requester_user_id, r.trade), " +
  "mine AS (UPDATE emergency_request_contact c SET status = 'accepted', note = $3, eta_minutes = $4, replied_at = now() FROM req WHERE c.request_id = req.id AND c.contractor_user_id = $2::uuid RETURNING 1), " +
  "others AS (UPDATE emergency_request_contact c SET status = 'closed', replied_at = now() FROM req WHERE c.request_id = req.id AND c.contractor_user_id <> $2::uuid AND c.status = 'sent' RETURNING 1) " +
  "SELECT id, number, requester_user_id, trade FROM req";
export const DECLINE_SQL =
  "UPDATE emergency_request_contact c SET status = 'declined', note = $3, replied_at = now() FROM emergency_request r " +
  `WHERE r.id = c.request_id AND r.id = $1::uuid AND r.status = 'open' AND r.created_at > now() - interval '${OPEN_HOURS} hours' AND c.contractor_user_id = $2::uuid AND c.status = 'sent' RETURNING r.number`;
export const CANCEL_SQL =
  "WITH req AS (UPDATE emergency_request SET status = 'cancelled' WHERE id = $1::uuid AND requester_user_id = $2::uuid AND status = 'open' RETURNING id), " +
  "closed AS (UPDATE emergency_request_contact c SET status = 'closed' FROM req WHERE c.request_id = req.id AND c.status = 'sent' RETURNING 1) SELECT id FROM req";

/**
 * Gives an accepted request its JOB- number (from the job board's own sequence, so numbers never clash) and, when the request is about one of
 * the requester's own listings, a real approved job so chat, visits and reviews work. Idempotent: does nothing once linked, so the cron can repair a gap.
 * Params: 1 request id, 2 service label.
 */
export const LINK_JOB_SQL =
  "WITH r AS (SELECT id, listing_id, requester_user_id, accepted_contractor_user_id, description FROM emergency_request " +
  "WHERE id = $1::uuid AND status = 'accepted' AND job_number IS NULL FOR UPDATE), " +
  "asg AS (INSERT INTO job_assignment (listing_id, owner_user_id, contractor_user_id, kind, status, approved_at, service_name, note, offer_source) " +
  "SELECT r.listing_id, r.requester_user_id, r.accepted_contractor_user_id, 'other', 'approved', now(), $2::text, left(r.description, 1000), 'owner' FROM r " +
  "WHERE r.listing_id IS NOT NULL RETURNING id, job_number), " +
  "nums AS (SELECT id AS assignment_id, job_number FROM asg UNION ALL SELECT NULL::uuid, nextval('job_number_seq')::integer FROM r WHERE r.listing_id IS NULL) " +
  "UPDATE emergency_request e SET assignment_id = nums.assignment_id, job_number = nums.job_number FROM r, nums WHERE e.id = r.id RETURNING e.job_number, e.assignment_id";
export async function linkJobPg(db: Queryable, requestId: string, serviceLabel: string): Promise<{ jobNumber: number; assignmentId: string | null } | undefined> {
  const row = (await db.query(LINK_JOB_SQL, [requestId, serviceLabel])).rows[0];
  return row ? { jobNumber: Number(row["job_number"]), assignmentId: str(row["assignment_id"]) } : undefined;
}

/** One contractor takes the job. Guarded single statement: only the first accept wins, and only a contractor who was sent the request. Undefined when it is no longer open. */
export async function acceptPg(db: Queryable, requestId: string, contractorId: string, r: { note: string | null; etaMinutes: number | null }): Promise<{ number: number; requesterId: string; trade: EmergencyTrade } | undefined> {
  const row = (await db.query(ACCEPT_SQL, [requestId, contractorId, r.note, r.etaMinutes])).rows[0];
  return row ? { number: Number(row["number"]), requesterId: String(row["requester_user_id"]), trade: row["trade"] as EmergencyTrade } : undefined;
}
export async function declinePg(db: Queryable, requestId: string, contractorId: string, note: string | null): Promise<boolean> {
  return (await db.query(DECLINE_SQL, [requestId, contractorId, note])).rows.length > 0;
}
export async function cancelPg(db: Queryable, requestId: string, requesterId: string): Promise<boolean> {
  return (await db.query(CANCEL_SQL, [requestId, requesterId])).rows.length > 0;
}

// ---- Widening: an open request with no answer is offered to the next contractors who are available ------------------------------------
export const WIDEN_AFTER_MINUTES = 15;
export const MAX_ROUNDS = 3;
export const MAX_CONTRACTORS_PER_REQUEST = 12;

export interface DueRequest { id: string; number: number; requesterId: string; trade: EmergencyTrade; description: string; suburb: string | null; postcode: string | null; propertyKind: "sale" | "rental" | "other"; round: number; requesterName: string }
/** Params: 1 now, 2 widen-after minutes, 3 max rounds. Open, unexpired, nobody accepted, last round at least that long ago. */
export const DUE_SQL =
  "SELECT r.id, r.number, r.requester_user_id, r.trade, r.description, r.suburb, r.postcode, r.property_kind, r.round, u.display_name " +
  "FROM emergency_request r JOIN app_user u ON u.id = r.requester_user_id " +
  `WHERE r.status = 'open' AND r.created_at > $1::timestamptz - interval '${OPEN_HOURS} hours' AND r.round < $3::integer ` +
  "AND r.last_round_at <= $1::timestamptz - make_interval(mins => $2::integer) " +
  "AND NOT EXISTS (SELECT 1 FROM emergency_request_contact c WHERE c.request_id = r.id AND c.status = 'accepted') ORDER BY r.last_round_at LIMIT 50";
export async function dueRequestsPg(db: Queryable, nowIso: string): Promise<DueRequest[]> {
  const { rows } = await db.query(DUE_SQL, [nowIso, WIDEN_AFTER_MINUTES, MAX_ROUNDS]);
  return rows.map(r => ({
    id: String(r["id"]), number: Number(r["number"]), requesterId: String(r["requester_user_id"]), trade: r["trade"] as EmergencyTrade, description: String(r["description"]),
    suburb: str(r["suburb"]), postcode: str(r["postcode"]), propertyKind: r["property_kind"] as DueRequest["propertyKind"], round: Number(r["round"]),
    requesterName: String(r["display_name"]).split(" ")[0] || "A customer"
  }));
}
export async function contactedPg(db: Queryable, requestId: string): Promise<string[]> {
  return (await db.query("SELECT contractor_user_id FROM emergency_request_contact WHERE request_id = $1::uuid", [requestId])).rows.map(r => String(r["contractor_user_id"]));
}
/** Moves the clock on. `newRound` is true when more contractors were asked; otherwise it only waits another interval. */
export async function markRoundPg(db: Queryable, requestId: string, nowIso: string, newRound: boolean): Promise<void> {
  await db.query("UPDATE emergency_request SET last_round_at = $2::timestamptz, round = CASE WHEN $3::boolean THEN least(round + 1, $4::integer) ELSE round END WHERE id = $1::uuid AND status = 'open'", [requestId, nowIso, newRound, MAX_ROUNDS]);
}
export async function unlinkedAcceptedPg(db: Queryable): Promise<{ id: string; trade: EmergencyTrade }[]> {
  return (await db.query("SELECT id, trade FROM emergency_request WHERE status = 'accepted' AND job_number IS NULL LIMIT 50")).rows.map(r => ({ id: String(r["id"]), trade: r["trade"] as EmergencyTrade }));
}

// ---- Directory cards: the contractor's public page from the job board -----------------------------------------------------------------
export interface ProfileCard { userId: string; contractorNo: number; headline: string; verified: boolean; ratingAvg: number | null; ratingCount: number; completed: number; photoUrl: string | null; testimonial: string | null }
/** Only contractors who published their page have a card. Rating, jobs and testimonial come from the visible reviews and completed jobs. */
export const CARDS_SQL =
  "SELECT pg.user_id, pg.contractor_no, coalesce(pg.headline, '') AS headline, (pg.licence_verified_at IS NOT NULL) AS verified, " +
  "(SELECT avg(r.rating)::float8 FROM contractor_review r WHERE r.contractor_user_id = pg.user_id AND r.status = 'visible') AS rating_avg, " +
  "(SELECT count(*) FROM contractor_review r WHERE r.contractor_user_id = pg.user_id AND r.status = 'visible')::int AS rating_count, " +
  "(SELECT count(*) FROM job_assignment a WHERE a.contractor_user_id = pg.user_id AND a.status = 'completed')::int AS completed, " +
  "(SELECT m.url FROM contractor_media m WHERE m.user_id = pg.user_id AND m.media_type = 'photo' ORDER BY m.sort_order LIMIT 1) AS photo_url, " +
  "(SELECT left(r.body, 160) FROM contractor_review r WHERE r.contractor_user_id = pg.user_id AND r.status = 'visible' AND r.rating >= 4 AND r.body IS NOT NULL ORDER BY r.created_at DESC LIMIT 1) AS testimonial " +
  "FROM contractor_page pg WHERE pg.is_public AND pg.user_id = ANY($1::uuid[])";
export async function profileCardsPg(db: Queryable, userIds: readonly string[]): Promise<Map<string, ProfileCard>> {
  const out = new Map<string, ProfileCard>();
  if (userIds.length === 0) return out;
  for (const r of (await db.query(CARDS_SQL, [[...userIds]])).rows) {
    out.set(String(r["user_id"]), {
      userId: String(r["user_id"]), contractorNo: Number(r["contractor_no"]), headline: String(r["headline"]), verified: r["verified"] === true,
      ratingAvg: r["rating_avg"] === null ? null : Number(r["rating_avg"]), ratingCount: Number(r["rating_count"]), completed: Number(r["completed"]),
      photoUrl: str(r["photo_url"]), testimonial: str(r["testimonial"])
    });
  }
  return out;
}

// ---- Staff view ------------------------------------------------------------------------------------------------------------------------
export interface StaffRequestRow {
  id: string; number: number; jobNumber: number | null; status: string; trade: string; suburb: string | null; postcode: string | null; propertyKind: string;
  description: string; createdAt: string; round: number; asked: number; delivered: number; declined: number; accepted: number; requesterName: string;
}
/** Newest requests with how many contractors were asked, reached by email or text, declined or accepted. No street address, phone or email. Params: 1 limit. */
export const STAFF_REQUESTS_SQL =
  `SELECT r.id, r.number, r.job_number, ${STATUS_EXPR} AS status, r.trade, r.suburb, r.postcode, r.property_kind, r.description, r.created_at, r.round, u.display_name, ` +
  "count(c.*)::int AS asked, count(*) FILTER (WHERE c.email_status = 'sent' OR c.sms_status = 'sent')::int AS delivered, " +
  "count(*) FILTER (WHERE c.status = 'declined')::int AS declined, count(*) FILTER (WHERE c.status = 'accepted')::int AS accepted " +
  "FROM emergency_request r JOIN app_user u ON u.id = r.requester_user_id LEFT JOIN emergency_request_contact c ON c.request_id = r.id " +
  "GROUP BY r.id, u.display_name ORDER BY r.created_at DESC LIMIT $1::integer";
export async function staffRequestsPg(db: Queryable, limit = 100): Promise<StaffRequestRow[]> {
  return (await db.query(STAFF_REQUESTS_SQL, [limit])).rows.map(r => ({
    id: String(r["id"]), number: Number(r["number"]), jobNumber: r["job_number"] === null ? null : Number(r["job_number"]), status: String(r["status"]), trade: String(r["trade"]),
    suburb: str(r["suburb"]), postcode: str(r["postcode"]), propertyKind: String(r["property_kind"]), description: String(r["description"]), createdAt: iso(r["created_at"]), round: Number(r["round"]),
    asked: Number(r["asked"]), delivered: Number(r["delivered"]), declined: Number(r["declined"]), accepted: Number(r["accepted"]), requesterName: String(r["display_name"])
  }));
}
export interface OutboxRow { channel: string; status: string; errorCode: string | null; at: string }
/** The emergency rows of the email and text log: channel, result and time only (the log holds no address, number or text). */
export async function emergencyOutboxPg(db: Queryable, limit = 100): Promise<OutboxRow[]> {
  return (await db.query("SELECT channel, status, error_code, created_at FROM messaging_outbox WHERE template = 'emergency_request' ORDER BY created_at DESC, id DESC LIMIT $1::integer", [limit]))
    .rows.map(r => ({ channel: String(r["channel"]), status: String(r["status"]), errorCode: str(r["error_code"]), at: iso(r["created_at"]) }));
}
