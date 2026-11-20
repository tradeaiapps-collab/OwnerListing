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
  "WHERE e.enabled AND ($1::text IS NULL OR e.trade = $1::text) AND u.status NOT IN ('suspended','closed') AND u.deleted_at IS NULL AND u.user_type IN ('vendor','agent') ORDER BY u.id LIMIT 2000";

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
  requesterName: string; addressText: string | null; callbackPhone: string | null; myStatus: string | null; replies: ContactView[];
}

const STATUS_EXPR = `CASE WHEN r.status = 'open' AND r.created_at <= now() - interval '${OPEN_HOURS} hours' THEN 'expired' ELSE r.status END`;
export const REQUESTS_SQL =
  `SELECT r.id, r.number, r.requester_user_id, ${STATUS_EXPR} AS status, r.trade, r.description, r.property_kind, r.suburb, r.postcode, r.created_at, r.address_text, r.callback_phone, ` +
  "r.accepted_contractor_user_id, u.display_name AS requester_name, mc.status AS my_status " +
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
  "AND EXISTS (SELECT 1 FROM emergency_request_contact c WHERE c.request_id = r.id AND c.contractor_user_id = $2::uuid AND c.status = 'sent') " +
  "RETURNING r.id, r.number, r.requester_user_id), " +
  "mine AS (UPDATE emergency_request_contact c SET status = 'accepted', note = $3, eta_minutes = $4, replied_at = now() FROM req WHERE c.request_id = req.id AND c.contractor_user_id = $2::uuid RETURNING 1), " +
  "others AS (UPDATE emergency_request_contact c SET status = 'closed', replied_at = now() FROM req WHERE c.request_id = req.id AND c.contractor_user_id <> $2::uuid AND c.status = 'sent' RETURNING 1) " +
  "SELECT id, number, requester_user_id FROM req";
export const DECLINE_SQL =
  "UPDATE emergency_request_contact c SET status = 'declined', note = $3, replied_at = now() FROM emergency_request r " +
  `WHERE r.id = c.request_id AND r.id = $1::uuid AND r.status = 'open' AND r.created_at > now() - interval '${OPEN_HOURS} hours' AND c.contractor_user_id = $2::uuid AND c.status = 'sent' RETURNING r.number`;
export const CANCEL_SQL =
  "WITH req AS (UPDATE emergency_request SET status = 'cancelled' WHERE id = $1::uuid AND requester_user_id = $2::uuid AND status = 'open' RETURNING id), " +
  "closed AS (UPDATE emergency_request_contact c SET status = 'closed' FROM req WHERE c.request_id = req.id AND c.status = 'sent' RETURNING 1) SELECT id FROM req";

/** One contractor takes the job. Guarded single statement: only the first accept wins, and only a contractor who was sent the request. Undefined when it is no longer open. */
export async function acceptPg(db: Queryable, requestId: string, contractorId: string, r: { note: string | null; etaMinutes: number | null }): Promise<{ number: number; requesterId: string } | undefined> {
  const row = (await db.query(ACCEPT_SQL, [requestId, contractorId, r.note, r.etaMinutes])).rows[0];
  return row ? { number: Number(row["number"]), requesterId: String(row["requester_user_id"]) } : undefined;
}
export async function declinePg(db: Queryable, requestId: string, contractorId: string, note: string | null): Promise<boolean> {
  return (await db.query(DECLINE_SQL, [requestId, contractorId, note])).rows.length > 0;
}
export async function cancelPg(db: Queryable, requestId: string, requesterId: string): Promise<boolean> {
  return (await db.query(CANCEL_SQL, [requestId, requesterId])).rows.length > 0;
}
