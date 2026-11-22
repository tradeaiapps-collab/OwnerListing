import { notSuspendedSql } from "./contractor-standing-sql";
import type { AuditEvent } from "../domain/audit";
import { buildStats, type ContractorStats, type MarketCard, type PageInput, type Trade } from "../domain/contractor-market";
import type { JobDetail, MarketStore, ServiceRow } from "../domain/job-board";
import type { AssignmentStatus } from "../domain/job-chat";
import type { Queryable } from "./db";

// Constant SQL text; user input travels only as bound parameters. Ids for writes come from the session or from stored rows.
// Every job write is ONE statement that also inserts its audit_event row. Nothing here deletes a job, a chat message or a review;
// the only DELETEs replace a contractor's own services and gallery links, which jobs never reference (a job copies the price it was booked at).

const CARD_SELECT =
  "SELECT u.id, pg.contractor_no, coalesce(pg.business_name, u.display_name) AS name, p.kind, coalesce(pg.trade_label, '') AS trade_label, coalesce(pg.headline, '') AS headline, " +
  "p.service_suburbs, p.service_postcodes, p.accepting_new, " +
  "(SELECT count(*) FROM job_assignment a WHERE a.contractor_user_id = u.id AND a.status IN ('proposed','approved')) AS open_jobs, " +
  "(SELECT min(s.price_cents) FROM contractor_service s WHERE s.user_id = u.id AND s.kind = p.kind) AS from_price, " +
  "(SELECT avg(r.rating)::float8 FROM contractor_review r WHERE r.contractor_user_id = u.id AND r.status = 'visible') AS rating_avg, " +
  "(SELECT count(*) FROM contractor_review r WHERE r.contractor_user_id = u.id AND r.status = 'visible') AS rating_count, " +
  "(pg.licence_verified_at IS NOT NULL) AS verified, " +
  "(SELECT count(*) FROM job_assignment a WHERE a.contractor_user_id = u.id AND a.status = 'completed') AS completed " +
  "FROM contractor_profile p JOIN app_user u ON u.id = p.user_id JOIN contractor_page pg ON pg.user_id = u.id " +
  "WHERE p.kind = $1::text AND pg.is_public AND u.status NOT IN ('suspended','closed') AND u.user_type IN ('vendor','agent')";
export const CARDS_SQL = CARD_SELECT + " ORDER BY pg.contractor_no LIMIT 500";
export const CARD_SQL = CARD_SELECT + " AND u.id = $2::uuid";
export const BY_NUMBER_SQL = "SELECT user_id FROM contractor_page WHERE contractor_no = $1::integer";
export const SERVICE_SQL = "SELECT id, kind, name, price_cents, price_type FROM contractor_service WHERE user_id = $1::uuid AND id = $2::uuid";
export const LISTING_AREA_SQL = "SELECT owner_user_id, title, address_text, suburb, postcode FROM property_listing WHERE id = $1::uuid";

const JOB_SELECT =
  "SELECT a.id, a.listing_id, a.owner_user_id, a.contractor_user_id, a.kind, a.status, a.job_number, a.created_at, a.offer_source, a.service_name, a.price_cents, a.note, " +
  "a.requested_time, a.proposed_time, a.scheduled_time, a.decline_reason, a.contractor_done_at, a.completed_at, l.title, l.address_text, l.suburb, " +
  "ou.display_name AS owner_name, coalesce(pg.business_name, cu.display_name) AS contractor_name, pg.contractor_no, r.rating, r.body AS review_body " +
  "FROM job_assignment a JOIN property_listing l ON l.id = a.listing_id JOIN app_user ou ON ou.id = a.owner_user_id JOIN app_user cu ON cu.id = a.contractor_user_id " +
  "LEFT JOIN contractor_page pg ON pg.user_id = a.contractor_user_id LEFT JOIN contractor_review r ON r.assignment_id = a.id ";
export const GET_JOB_SQL = JOB_SELECT + "WHERE a.id = $1::uuid";
export const LIST_JOBS_SQL = JOB_SELECT + "WHERE a.owner_user_id = $1::uuid OR a.contractor_user_id = $1::uuid ORDER BY a.created_at DESC LIMIT 200";

export const STATS_SQL =
  "SELECT count(*) AS received, count(*) FILTER (WHERE approved_at IS NOT NULL) AS accepted, " +
  "count(*) FILTER (WHERE status = 'cancelled' AND approved_at IS NULL AND responded_at IS NOT NULL) AS rejected, " +
  "count(*) FILTER (WHERE status = 'completed') AS completed, count(*) FILTER (WHERE status = 'proposed') AS pending, " +
  "count(*) FILTER (WHERE created_at >= date_trunc('month', now())) AS this_month, " +
  "avg(extract(epoch FROM (responded_at - created_at)) / 60) FILTER (WHERE responded_at IS NOT NULL) AS avg_response_minutes, " +
  "(SELECT avg(rating)::float8 FROM contractor_review WHERE contractor_user_id = $1::uuid AND status = 'visible') AS rating_avg, " +
  "(SELECT count(*) FROM contractor_review WHERE contractor_user_id = $1::uuid AND status = 'visible') AS rating_count " +
  "FROM job_assignment WHERE contractor_user_id = $1::uuid";

export const DECLINE_REASON_SQL =
  "UPDATE job_assignment SET decline_reason = $3::text WHERE id = $1::uuid AND contractor_user_id = $2::uuid AND status = 'cancelled' AND decline_reason IS NULL";

const AUDIT_FROM = "INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) " +
  "SELECT $A::uuid, $B::timestamptz, 'user', $ACTOR::text, 'job_assignment', moved.id::text, $C::text, $D::text, $E::jsonb FROM moved RETURNING aggregate_id";
/** Params: 1 id, 2 actor, then the statement's own extras, then 5 audit params starting at `n`. */
const withAudit = (update: string, n: number) =>
  "WITH moved AS (" + update + " RETURNING id) " +
  AUDIT_FROM.replace("$A", `$${n}`).replace("$B", `$${n + 1}`).replace("$C", `$${n + 2}`).replace("$D", `$${n + 3}`).replace("$E", `$${n + 4}`).replace("$ACTOR", "$2");

export const PROPOSE_TIME_SQL = withAudit(
  "UPDATE job_assignment SET proposed_time = $3::timestamptz WHERE id = $1::uuid AND contractor_user_id = $2::uuid AND status IN ('proposed','approved') AND " + notSuspendedSql("contractor_user_id"), 4);
export const ACCEPT_TIME_SQL = withAudit(
  "UPDATE job_assignment SET scheduled_time = proposed_time, proposed_time = NULL, " +
  "approved_at = CASE WHEN status = 'proposed' THEN now() ELSE approved_at END, status = CASE WHEN status = 'proposed' THEN 'approved' ELSE status END, " +
  "responded_at = coalesce(responded_at, now()) WHERE id = $1::uuid AND owner_user_id = $2::uuid AND proposed_time IS NOT NULL AND status IN ('proposed','approved') AND " + notSuspendedSql("contractor_user_id"), 3);
export const REJECT_TIME_SQL = withAudit(
  "UPDATE job_assignment SET proposed_time = NULL WHERE id = $1::uuid AND owner_user_id = $2::uuid AND proposed_time IS NOT NULL AND status IN ('proposed','approved')", 3);
export const MARK_DONE_SQL = withAudit(
  "UPDATE job_assignment SET contractor_done_at = now() WHERE id = $1::uuid AND contractor_user_id = $2::uuid AND status = 'approved' AND contractor_done_at IS NULL AND " + notSuspendedSql("contractor_user_id"), 3);
export const ADD_REVIEW_SQL =
  "WITH moved AS (INSERT INTO contractor_review (assignment_id, contractor_user_id, owner_user_id, rating, body) " +
  "SELECT a.id, a.contractor_user_id, a.owner_user_id, $3::integer, nullif($4::text, '') FROM job_assignment a " +
  "WHERE a.id = $1::uuid AND a.owner_user_id = $2::uuid AND a.status = 'completed' ON CONFLICT (assignment_id) DO NOTHING RETURNING assignment_id AS id) " +
  AUDIT_FROM.replace("$A", "$5").replace("$B", "$6").replace("$C", "$7").replace("$D", "$8").replace("$E", "$9").replace("$ACTOR", "$2");

const n = (v: unknown) => Number(v);
const iso = (v: unknown) => (v == null ? undefined : new Date(v as string | Date).toISOString());
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const auditParams = (e: AuditEvent) => [e.id, e.occurredAt, e.eventType, e.correlationId, JSON.stringify(e.payload)];

const toCard = (r: Record<string, unknown>): MarketCard => ({
  userId: String(r["id"]), contractorNo: n(r["contractor_no"]), name: String(r["name"]), trade: String(r["kind"]) as Trade, tradeLabel: String(r["trade_label"]),
  headline: String(r["headline"]), suburbs: strs(r["service_suburbs"]), postcodes: strs(r["service_postcodes"]), acceptingNew: r["accepting_new"] === true,
  openJobs: n(r["open_jobs"]), fromPriceCents: r["from_price"] == null ? null : n(r["from_price"]),
  ratingAvg: r["rating_avg"] == null ? null : Math.round(n(r["rating_avg"]) * 10) / 10, ratingCount: n(r["rating_count"]),
  licenceVerified: r["verified"] === true, completed: n(r["completed"])
});

const toJob = (r: Record<string, unknown>): JobDetail => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), ownerUserId: String(r["owner_user_id"]), contractorUserId: String(r["contractor_user_id"]),
  kind: String(r["kind"]) as JobDetail["kind"], status: String(r["status"]) as AssignmentStatus, jobNumber: n(r["job_number"]),
  listingTitle: String(r["title"]), address: String(r["address_text"]), ...(r["suburb"] ? { suburb: String(r["suburb"]) } : {}),
  ownerName: String(r["owner_name"]), contractorName: String(r["contractor_name"]), ...(r["contractor_no"] != null ? { contractorNo: n(r["contractor_no"]) } : {}),
  createdAt: iso(r["created_at"]) ?? "", offerSource: r["offer_source"] === "elena" ? "elena" : "owner",
  ...(r["service_name"] != null ? { serviceName: String(r["service_name"]) } : {}), ...(r["price_cents"] != null ? { priceCents: n(r["price_cents"]) } : {}),
  ...(r["note"] != null ? { note: String(r["note"]) } : {}), ...(r["requested_time"] != null ? { requestedTime: iso(r["requested_time"]) as string } : {}),
  ...(r["proposed_time"] != null ? { proposedTime: iso(r["proposed_time"]) as string } : {}), ...(r["scheduled_time"] != null ? { scheduledTime: iso(r["scheduled_time"]) as string } : {}),
  ...(r["decline_reason"] != null ? { declineReason: String(r["decline_reason"]) } : {}), ...(r["contractor_done_at"] != null ? { contractorDoneAt: iso(r["contractor_done_at"]) as string } : {}),
  ...(r["completed_at"] != null ? { completedAt: iso(r["completed_at"]) as string } : {}),
  ...(r["rating"] != null ? { review: { rating: n(r["rating"]), body: r["review_body"] == null ? "" : String(r["review_body"]) } } : {})
});

export function createPgMarketStore(db: Queryable): MarketStore {
  const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows.length === 1;
  return {
    async cards(trade) { return (await db.query(CARDS_SQL, [trade])).rows.map(toCard); },
    async card(userId, trade) { const r = (await db.query(CARD_SQL, [trade, userId])).rows[0]; return r ? toCard(r) : undefined; },
    async contractorByNumber(no) { const r = (await db.query(BY_NUMBER_SQL, [no])).rows[0]; return r ? { userId: String(r["user_id"]) } : undefined; },
    async service(userId, serviceId): Promise<ServiceRow | undefined> {
      const r = (await db.query(SERVICE_SQL, [userId, serviceId])).rows[0];
      return r ? { id: String(r["id"]), kind: String(r["kind"]) as Trade, name: String(r["name"]), priceCents: n(r["price_cents"]), priceType: String(r["price_type"]) as ServiceRow["priceType"] } : undefined;
    },
    async listingArea(id) {
      const r = (await db.query(LISTING_AREA_SQL, [id])).rows[0];
      return r ? { ownerUserId: String(r["owner_user_id"]), title: String(r["title"]), address: String(r["address_text"]), ...(r["suburb"] ? { suburb: String(r["suburb"]) } : {}), ...(r["postcode"] ? { postcode: String(r["postcode"]).trim() } : {}) } : undefined;
    },
    async getJob(id) { const r = (await db.query(GET_JOB_SQL, [id])).rows[0]; return r ? toJob(r) : undefined; },
    async listJobs(userId) { return (await db.query(LIST_JOBS_SQL, [userId])).rows.map(toJob); },
    stats: userId => contractorStatsPg(db, userId),
    async setDeclineReason(id, contractorId, reason) { await db.query(DECLINE_REASON_SQL, [id, contractorId, reason]); },
    proposeTime: (id, contractorId, time, a) => one(PROPOSE_TIME_SQL, [id, contractorId, time, ...auditParams(a)]),
    acceptTime: (id, ownerId, a) => one(ACCEPT_TIME_SQL, [id, ownerId, ...auditParams(a)]),
    rejectTime: (id, ownerId, a) => one(REJECT_TIME_SQL, [id, ownerId, ...auditParams(a)]),
    markDone: (id, contractorId, a) => one(MARK_DONE_SQL, [id, contractorId, ...auditParams(a)]),
    addReview: (id, ownerId, rating, body, a) => one(ADD_REVIEW_SQL, [id, ownerId, rating, body, ...auditParams(a)])
  };
}

export async function contractorStatsPg(db: Queryable, userId: string): Promise<ContractorStats> {
  const r = (await db.query(STATS_SQL, [userId])).rows[0] ?? {};
  return buildStats(
    { received: n(r["received"] ?? 0), accepted: n(r["accepted"] ?? 0), rejected: n(r["rejected"] ?? 0), completed: n(r["completed"] ?? 0), pending: n(r["pending"] ?? 0),
      thisMonth: n(r["this_month"] ?? 0), avgResponseMinutes: r["avg_response_minutes"] == null ? null : n(r["avg_response_minutes"]) },
    { avg: r["rating_avg"] == null ? null : n(r["rating_avg"]), count: n(r["rating_count"] ?? 0) }
  );
}

// ---- The contractor's page: own editor, public list, public profile ---------------------------------------------------------

export const OWN_PAGE_SQL = "SELECT contractor_no, business_name, headline, about, trade_label, licence_number, licence_state, licence_verified_at, is_public FROM contractor_page WHERE user_id = $1::uuid";
export const OWN_SERVICES_SQL = "SELECT id, kind, name, description, price_cents, price_type FROM contractor_service WHERE user_id = $1::uuid ORDER BY sort_order, name";
export const OWN_MEDIA_SQL = "SELECT id, media_type, url, caption FROM contractor_media WHERE user_id = $1::uuid ORDER BY sort_order";
export const UPSERT_PAGE_SQL =
  "INSERT INTO contractor_page (user_id, business_name, headline, about, trade_label, licence_number, licence_state, is_public, updated_at) " +
  "VALUES ($1::uuid, nullif($2::text, ''), nullif($3::text, ''), nullif($4::text, ''), nullif($5::text, ''), nullif($6::text, ''), nullif($7::text, ''), $8::boolean, now()) " +
  "ON CONFLICT (user_id) DO UPDATE SET business_name = EXCLUDED.business_name, headline = EXCLUDED.headline, about = EXCLUDED.about, trade_label = EXCLUDED.trade_label, " +
  // A changed licence number or state needs checking again.
  "licence_verified_at = CASE WHEN contractor_page.licence_number IS NOT DISTINCT FROM EXCLUDED.licence_number AND contractor_page.licence_state IS NOT DISTINCT FROM EXCLUDED.licence_state THEN contractor_page.licence_verified_at ELSE NULL END, " +
  "licence_number = EXCLUDED.licence_number, licence_state = EXCLUDED.licence_state, is_public = EXCLUDED.is_public, updated_at = now() RETURNING contractor_no";
export const ENSURE_PAGE_SQL = "INSERT INTO contractor_page (user_id) VALUES ($1::uuid) ON CONFLICT (user_id) DO NOTHING";
export const CLEAR_SERVICES_SQL = "DELETE FROM contractor_service WHERE user_id = $1::uuid";
export const CLEAR_MEDIA_SQL = "DELETE FROM contractor_media WHERE user_id = $1::uuid";
export const INSERT_SERVICES_SQL =
  "INSERT INTO contractor_service (user_id, kind, name, description, price_cents, price_type, sort_order) " +
  "SELECT $1::uuid, k, nm, nullif(d, ''), p, t, o FROM unnest($2::text[], $3::text[], $4::text[], $5::integer[], $6::text[], $7::integer[]) AS x(k, nm, d, p, t, o)";
export const INSERT_MEDIA_SQL =
  "INSERT INTO contractor_media (user_id, media_type, url, caption, sort_order) " +
  "SELECT $1::uuid, m, u, nullif(c, ''), o FROM unnest($2::text[], $3::text[], $4::text[], $5::integer[]) AS x(m, u, c, o)";

export async function loadOwnPage(db: Queryable, userId: string) {
  const [page, services, media, stats] = await Promise.all([db.query(OWN_PAGE_SQL, [userId]), db.query(OWN_SERVICES_SQL, [userId]), db.query(OWN_MEDIA_SQL, [userId]), contractorStatsPg(db, userId)]);
  const p = page.rows[0];
  return {
    page: p ? { contractorNo: n(p["contractor_no"]), businessName: String(p["business_name"] ?? ""), headline: String(p["headline"] ?? ""), about: String(p["about"] ?? ""), tradeLabel: String(p["trade_label"] ?? ""),
      licenceNumber: String(p["licence_number"] ?? ""), licenceState: String(p["licence_state"] ?? "").trim(), licenceVerified: p["licence_verified_at"] != null, isPublic: p["is_public"] === true } : null,
    services: services.rows.map(r => ({ id: String(r["id"]), kind: String(r["kind"]), name: String(r["name"]), description: String(r["description"] ?? ""), priceCents: n(r["price_cents"]), priceType: String(r["price_type"]) })),
    media: media.rows.map(r => ({ id: String(r["id"]), mediaType: String(r["media_type"]), url: String(r["url"]), caption: String(r["caption"] ?? "") })),
    stats
  };
}

export async function savePage(db: Queryable, userId: string, p: PageInput): Promise<number> {
  const run = async (q: Queryable): Promise<number> => {
    const r = await q.query(UPSERT_PAGE_SQL, [userId, p.businessName, p.headline, p.about, p.tradeLabel, p.licenceNumber, p.licenceState, p.isPublic]);
    await q.query(CLEAR_SERVICES_SQL, [userId]);
    if (p.services.length) await q.query(INSERT_SERVICES_SQL, [userId, p.services.map(s => s.kind), p.services.map(s => s.name), p.services.map(s => s.description), p.services.map(s => s.priceCents), p.services.map(s => s.priceType), p.services.map((_, i) => i)]);
    await q.query(CLEAR_MEDIA_SQL, [userId]);
    if (p.media.length) await q.query(INSERT_MEDIA_SQL, [userId, p.media.map(m => m.mediaType), p.media.map(m => m.url), p.media.map(m => m.caption), p.media.map((_, i) => i)]);
    return n(r.rows[0]?.["contractor_no"]);
  };
  return db.transaction ? db.transaction(run) : run(db);
}

export const SEARCH_SQL =
  "SELECT pg.user_id, pg.contractor_no, coalesce(pg.business_name, u.display_name) AS name, coalesce(pg.headline, '') AS headline, coalesce(pg.trade_label, '') AS trade_label, " +
  "(pg.licence_verified_at IS NOT NULL) AS verified, " +
  "(SELECT array_agg(DISTINCT p2.kind) FROM contractor_profile p2 WHERE p2.user_id = pg.user_id) AS kinds, " +
  "(SELECT array_agg(DISTINCT s) FROM contractor_profile p3, unnest(p3.service_suburbs) AS s WHERE p3.user_id = pg.user_id) AS suburbs, " +
  "(SELECT min(price_cents) FROM contractor_service WHERE user_id = pg.user_id AND ($1::text IS NULL OR kind = $1::text)) AS from_price, " +
  "(SELECT avg(rating)::float8 FROM contractor_review WHERE contractor_user_id = pg.user_id AND status = 'visible') AS rating_avg, " +
  "(SELECT count(*) FROM contractor_review WHERE contractor_user_id = pg.user_id AND status = 'visible') AS rating_count, " +
  "(SELECT count(*) FROM job_assignment WHERE contractor_user_id = pg.user_id AND status = 'completed') AS completed " +
  "FROM contractor_page pg JOIN app_user u ON u.id = pg.user_id " +
  "WHERE pg.is_public AND u.status NOT IN ('suspended','closed') AND u.user_type IN ('vendor','agent') " +
  "AND EXISTS (SELECT 1 FROM contractor_profile p WHERE p.user_id = pg.user_id AND p.accepting_new AND ($1::text IS NULL OR p.kind = $1::text) " +
  "AND ($2::text IS NULL OR $2::text = ANY(p.service_postcodes) OR EXISTS (SELECT 1 FROM unnest(p.service_suburbs) s WHERE lower(s) = lower($2::text)))) " +
  "AND ($3::text IS NULL OR lower(coalesce(pg.business_name, u.display_name)) LIKE '%' || lower($3::text) || '%') " +
  "ORDER BY pg.contractor_no LIMIT 60";

export interface SearchRow { contractorNo: number; name: string; headline: string; tradeLabel: string; verified: boolean; kinds: string[]; suburbs: string[]; fromPriceCents: number | null; ratingAvg: number | null; ratingCount: number; completed: number }
export async function searchContractors(db: Queryable, q: { trade?: string; area?: string; text?: string }): Promise<SearchRow[]> {
  const like = q.text?.replace(/[\\%_]/g, " ").trim().slice(0, 60) || null;
  const rows = (await db.query(SEARCH_SQL, [q.trade ?? null, q.area?.trim().slice(0, 80) || null, like])).rows;
  return rows.map(r => ({
    contractorNo: n(r["contractor_no"]), name: String(r["name"]), headline: String(r["headline"]), tradeLabel: String(r["trade_label"]), verified: r["verified"] === true,
    kinds: strs(r["kinds"]), suburbs: strs(r["suburbs"]).slice(0, 8), fromPriceCents: r["from_price"] == null ? null : n(r["from_price"]),
    ratingAvg: r["rating_avg"] == null ? null : Math.round(n(r["rating_avg"]) * 10) / 10, ratingCount: n(r["rating_count"]), completed: n(r["completed"])
  }));
}

export const PUBLIC_PAGE_SQL =
  "SELECT pg.user_id, pg.contractor_no, coalesce(pg.business_name, u.display_name) AS name, pg.headline, pg.about, pg.trade_label, pg.licence_number, pg.licence_state, " +
  "(pg.licence_verified_at IS NOT NULL) AS verified FROM contractor_page pg JOIN app_user u ON u.id = pg.user_id " +
  "WHERE pg.contractor_no = $1::integer AND pg.is_public AND u.status NOT IN ('suspended','closed')";
export const PUBLIC_AREAS_SQL = "SELECT kind, accepting_new, service_suburbs, service_postcodes FROM contractor_profile WHERE user_id = $1::uuid ORDER BY kind";
export const PUBLIC_REVIEWS_SQL =
  "SELECT r.rating, r.body, r.created_at, split_part(ou.display_name, ' ', 1) AS first_name, left(split_part(ou.display_name, ' ', 2), 1) AS initial " +
  "FROM contractor_review r JOIN app_user ou ON ou.id = r.owner_user_id WHERE r.contractor_user_id = $1::uuid AND r.status = 'visible' ORDER BY r.created_at DESC LIMIT 20";

/** Public profile: aggregate job figures only, reviewer shown as "First L.", never an email or a listing address. */
export async function loadPublicProfile(db: Queryable, no: number) {
  const p = (await db.query(PUBLIC_PAGE_SQL, [no])).rows[0];
  if (!p) return undefined;
  const userId = String(p["user_id"]);
  const [own, areas, reviews] = await Promise.all([loadOwnPage(db, userId), db.query(PUBLIC_AREAS_SQL, [userId]), db.query(PUBLIC_REVIEWS_SQL, [userId])]);
  return {
    contractorNo: n(p["contractor_no"]), name: String(p["name"]), headline: String(p["headline"] ?? ""), about: String(p["about"] ?? ""), tradeLabel: String(p["trade_label"] ?? ""),
    licence: p["licence_number"] ? { number: String(p["licence_number"]), state: String(p["licence_state"] ?? "").trim(), verified: p["verified"] === true } : null,
    services: own.services.map(({ id, kind, name, description, priceCents, priceType }) => ({ id, kind, name, description, priceCents, priceType })), media: own.media,
    areas: areas.rows.map(r => ({ kind: String(r["kind"]), acceptingNew: r["accepting_new"] === true, suburbs: strs(r["service_suburbs"]), postcodes: strs(r["service_postcodes"]) })),
    stats: { received: own.stats.received, completed: own.stats.completed, completionRate: own.stats.completionRate, avgResponseMinutes: own.stats.avgResponseMinutes, thisMonth: own.stats.thisMonth, accepted: own.stats.accepted, rejected: own.stats.rejected, ratingAvg: own.stats.ratingAvg, ratingCount: own.stats.ratingCount },
    reviews: reviews.rows.map(r => ({ rating: n(r["rating"]), body: String(r["body"] ?? ""), at: iso(r["created_at"]) ?? "", by: `${String(r["first_name"])}${r["initial"] ? ` ${String(r["initial"])}.` : ""}` }))
  };
}
