import { randomUUID } from "node:crypto";
import { hedraVideoFromEnv } from "../adapters/hedra-video";
import { objectStorageFromEnv } from "../adapters/object-storage";
import type { AuditEvent } from "../domain/audit";
import {
  completeBuyerPurchase, runVideoQueue, type AgentVideoRow, type BudgetView, type CheckoutPort, type ListingVideo, type Membership, type Purchase,
  type VideoIds, type VideoModel, type VideoProvider, type VideoRepository
} from "../domain/listing-video";
import { getDb } from "./context";
import { appendAuditPg, type Queryable } from "./db";
import { parseCheckoutEvent, stripeCheckoutFromEnv } from "./stripe-checkout";
import { stripeSignatureValid } from "./stripe-payouts";

// Constant SQL text; input only travels as bound parameters. Nothing here deletes a video or a ledger row.
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const s = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : s(v));

const VIDEO_COLS =
  "id, listing_id, model, requested_by, team_id, status, provider_job_id, storage_key, content_type, cost_cents, attempts, next_attempt_at, deadline_at, error, visibility, requested_at, generated_at, published_at, archived_at";
const INSERT_VIDEO_SQL =
  `INSERT INTO listing_video (${VIDEO_COLS}) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz,$14,$15,$16::timestamptz,$17,$18,$19) ON CONFLICT DO NOTHING RETURNING id`;
export const LISTING_SQL = "SELECT id, owner_user_id, status, title, COALESCE(description, '') AS description, property_type, COALESCE(suburb, '') AS suburb FROM property_listing WHERE id = $1::uuid";
export const APPOINTED_SQL = "SELECT 1 FROM listing_agent_appointment WHERE listing_id = $1::uuid AND agent_user_id = $2::uuid AND revoked_at IS NULL";
export const MEMBERSHIP_SQL = "SELECT team_id, role FROM agency_team_member WHERE user_id = $1::uuid AND removed_at IS NULL AND role IN ('manager','agent') ORDER BY added_at, team_id LIMIT 1";
export const IS_MEMBER_SQL = "SELECT 1 FROM agency_team_member WHERE team_id = $1::uuid AND user_id = $2::uuid AND removed_at IS NULL";
export const BUDGET_SQL =
  "SELECT b.monthly_budget_cents, COALESCE((SELECT SUM(amount_cents) FROM team_video_ledger WHERE team_id = b.team_id AND created_at >= $2::timestamptz), 0) AS spent " +
  "FROM team_video_budget b WHERE b.team_id = $1::uuid";
export const LOCK_BUDGET_SQL = "SELECT monthly_budget_cents FROM team_video_budget WHERE team_id = $1::uuid FOR UPDATE";
export const SPENT_SQL = "SELECT COALESCE(SUM(amount_cents), 0) AS spent FROM team_video_ledger WHERE team_id = $1::uuid AND created_at >= $2::timestamptz";
export const UPSERT_BUDGET_SQL =
  "INSERT INTO team_video_budget (team_id, monthly_budget_cents, set_by) VALUES ($1::uuid, $2, $3::uuid) " +
  "ON CONFLICT (team_id) DO UPDATE SET monthly_budget_cents = EXCLUDED.monthly_budget_cents, set_by = EXCLUDED.set_by, updated_at = now()";
export const INSERT_LEDGER_SQL = "INSERT INTO team_video_ledger (id, team_id, video_id, kind, amount_cents, created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::timestamptz)";
export const LIVE_BUYER_SQL = `SELECT ${VIDEO_COLS} FROM listing_video WHERE listing_id = $1::uuid AND model = 'buyer' AND archived_at IS NULL AND status <> 'failed'`;
export const CLAIM_SQL =
  `UPDATE listing_video SET next_attempt_at = $2::timestamptz WHERE id IN (
     SELECT id FROM listing_video WHERE status IN ('queued','processing') AND archived_at IS NULL AND next_attempt_at <= $1::timestamptz
     ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED) RETURNING ${VIDEO_COLS}`;
/** Newest layout's visible photos, in gallery order (the first two become the start and end frame). */
export const PHOTO_FILES_SQL =
  "SELECT p.storage_key, p.content_type FROM listing_photo p, " +
  "(SELECT entries FROM listing_photo_layout WHERE listing_id = $1::uuid ORDER BY version DESC LIMIT 1) l, " +
  "jsonb_array_elements(l.entries) WITH ORDINALITY AS e(entry, pos) " +
  "WHERE p.listing_id = $1::uuid AND p.kind = 'photo' AND p.id = (e.entry->>'photoId')::uuid AND COALESCE((e.entry->>'hidden')::boolean, false) = false " +
  "ORDER BY e.pos LIMIT $2";
export const AGENT_OVERVIEW_SQL =
  "SELECT l.id, l.title, COALESCE(l.suburb, '') AS suburb, l.status, " +
  "(SELECT COUNT(*) FROM listing_photo p WHERE p.listing_id = l.id AND p.kind = 'photo') AS photo_count, " +
  "v.id AS video_id, v.status AS video_status, v.visibility, v.requested_at, v.generated_at, v.error, v.attempts " +
  "FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id " +
  "LEFT JOIN LATERAL (SELECT * FROM listing_video x WHERE x.listing_id = l.id AND x.model = 'team' AND x.archived_at IS NULL ORDER BY x.requested_at DESC LIMIT 1) v ON true " +
  "WHERE a.agent_user_id = $1::uuid AND a.revoked_at IS NULL ORDER BY l.title, l.id LIMIT 200";

const toVideo = (r: Record<string, unknown>): ListingVideo => ({
  id: s(r["id"]), listingId: s(r["listing_id"]), model: s(r["model"]) as VideoModel, requestedBy: s(r["requested_by"]), teamId: strOrNull(r["team_id"]),
  status: s(r["status"]) as ListingVideo["status"], providerJobId: strOrNull(r["provider_job_id"]), storageKey: strOrNull(r["storage_key"]),
  contentType: strOrNull(r["content_type"]), costCents: Number(r["cost_cents"]), attempts: Number(r["attempts"]), nextAttemptAt: iso(r["next_attempt_at"]),
  deadlineAt: iso(r["deadline_at"]), error: s(r["error"]), visibility: s(r["visibility"]) as ListingVideo["visibility"], requestedAt: iso(r["requested_at"]),
  generatedAt: isoOrNull(r["generated_at"]), publishedAt: isoOrNull(r["published_at"]), archivedAt: isoOrNull(r["archived_at"])
});
const videoParams = (v: ListingVideo) => [
  v.id, v.listingId, v.model, v.requestedBy, v.teamId, v.status, v.providerJobId, v.storageKey, v.contentType, v.costCents, v.attempts,
  v.nextAttemptAt, v.deadlineAt, v.error, v.visibility, v.requestedAt, v.generatedAt, v.publishedAt, v.archivedAt
];
const toPurchase = (r: Record<string, unknown>): Purchase => ({
  id: s(r["id"]), listingId: s(r["listing_id"]), buyerId: s(r["buyer_id"]), videoId: strOrNull(r["video_id"]), amountCents: Number(r["amount_cents"]),
  sessionId: strOrNull(r["checkout_session_id"]), status: s(r["status"]) as Purchase["status"]
});
const PURCHASE_COLS = "id, listing_id, buyer_id, video_id, amount_cents, checkout_session_id, status";

export function createPgVideoRepository(db: Queryable): VideoRepository {
  const one = async (sql: string, params: unknown[], q: Queryable = db) => (await q.query(sql, params)).rows[0];
  return {
    async listing(id) {
      const r = await one(LISTING_SQL, [id]);
      return r ? { id: s(r["id"]), ownerUserId: s(r["owner_user_id"]), status: s(r["status"]), title: s(r["title"]), description: s(r["description"]), propertyType: s(r["property_type"]), suburb: s(r["suburb"]) } : undefined;
    },
    async isAppointedAgent(listingId, userId) { return !!(await one(APPOINTED_SQL, [listingId, userId])); },
    async membership(userId): Promise<Membership | undefined> {
      const r = await one(MEMBERSHIP_SQL, [userId]);
      return r ? { teamId: s(r["team_id"]), role: s(r["role"]) as Membership["role"] } : undefined;
    },
    async isTeamMember(teamId, userId) { return !!(await one(IS_MEMBER_SQL, [teamId, userId])); },
    async budget(teamId, monthStartIso): Promise<BudgetView | undefined> {
      const r = await one(BUDGET_SQL, [teamId, monthStartIso]);
      if (!r) return undefined;
      const cap = Number(r["monthly_budget_cents"]), spent = Number(r["spent"]);
      return { teamId, monthlyBudgetCents: cap, spentCents: spent, remainingCents: Math.max(0, cap - spent), monthStart: monthStartIso };
    },
    setBudget: (teamId, cents, by, audit) => atomic(db, async tx => {
      await tx.query(UPSERT_BUDGET_SQL, [teamId, cents, by]);
      await appendAuditPg(tx, audit);
    }),
    queueTeamVideo: (v, monthStartIso, audit) => atomic(db, async tx => {
      const b = await one(LOCK_BUDGET_SQL, [v.teamId], tx);
      if (!b) return "budget";
      const spent = Number((await one(SPENT_SQL, [v.teamId, monthStartIso], tx))!["spent"]);
      if (spent + v.costCents > Number(b["monthly_budget_cents"])) return "budget";
      if ((await tx.query(INSERT_VIDEO_SQL, videoParams(v))).rows.length === 0) return "exists";
      await tx.query(INSERT_LEDGER_SQL, [randomUUID(), v.teamId, v.id, "charge", v.costCents, v.requestedAt]);
      await appendAuditPg(tx, audit);
      return "queued";
    }),
    queueBuyerVideo: (v, audit) => atomic(db, async tx => {
      const existing = await one(LIVE_BUYER_SQL, [v.listingId], tx);
      if (existing) return toVideo(existing);
      if ((await tx.query(INSERT_VIDEO_SQL, videoParams(v))).rows.length === 0) return toVideo((await one(LIVE_BUYER_SQL, [v.listingId], tx))!);
      await appendAuditPg(tx, audit);
      return v;
    }),
    async video(id) { const r = await one(`SELECT ${VIDEO_COLS} FROM listing_video WHERE id = $1::uuid`, [id]); return r ? toVideo(r) : undefined; },
    async videosForListing(listingId) {
      return (await db.query(`SELECT ${VIDEO_COLS} FROM listing_video WHERE listing_id = $1::uuid ORDER BY requested_at DESC LIMIT 50`, [listingId])).rows.map(toVideo);
    },
    async liveVideo(listingId, model) {
      const r = await one(`SELECT ${VIDEO_COLS} FROM listing_video WHERE listing_id = $1::uuid AND model = $2 AND archived_at IS NULL AND status <> 'failed' ORDER BY requested_at DESC LIMIT 1`, [listingId, model]);
      return r ? toVideo(r) : undefined;
    },
    async publicVideo(listingId) {
      const r = await one(`SELECT ${VIDEO_COLS} FROM listing_video WHERE listing_id = $1::uuid AND visibility = 'public' AND status = 'ready' AND archived_at IS NULL ORDER BY published_at DESC LIMIT 1`, [listingId]);
      return r ? toVideo(r) : undefined;
    },
    async setVisibility(id, visibility, nowIso) {
      return (await db.query("UPDATE listing_video SET visibility = $2, published_at = CASE WHEN $2 = 'public' THEN $3::timestamptz ELSE NULL END WHERE id = $1::uuid AND archived_at IS NULL RETURNING id", [id, visibility, nowIso])).rows.length > 0;
    },
    async archive(id, nowIso) {
      return (await db.query("UPDATE listing_video SET archived_at = $2::timestamptz, visibility = 'private' WHERE id = $1::uuid AND archived_at IS NULL RETURNING id", [id, nowIso])).rows.length > 0;
    },
    async photoFiles(listingId, max) {
      return (await db.query(PHOTO_FILES_SQL, [listingId, max])).rows.map(r => ({ storageKey: s(r["storage_key"]), contentType: s(r["content_type"]) }));
    },
    async agentOverview(userId): Promise<AgentVideoRow[]> {
      return (await db.query(AGENT_OVERVIEW_SQL, [userId])).rows.map(r => ({
        listingId: s(r["id"]), title: s(r["title"]), suburb: s(r["suburb"]), status: s(r["status"]), photoCount: Number(r["photo_count"]),
        video: r["video_id"] ? {
          id: s(r["video_id"]), status: s(r["video_status"]) as ListingVideo["status"], visibility: s(r["visibility"]) as ListingVideo["visibility"],
          requestedAt: iso(r["requested_at"]), generatedAt: isoOrNull(r["generated_at"]), error: s(r["error"]), attempts: Number(r["attempts"])
        } : null
      }));
    },
    async claimDue(nowIso, leaseUntilIso, limit) { return (await db.query(CLAIM_SQL, [nowIso, leaseUntilIso, limit])).rows.map(toVideo); },
    async markSubmitted(id, jobId, attempts, nextIso) {
      await db.query("UPDATE listing_video SET status = 'processing', provider_job_id = $2, attempts = $3, next_attempt_at = $4::timestamptz WHERE id = $1::uuid", [id, jobId, attempts, nextIso]);
    },
    async keepWaiting(id, nextIso) { await db.query("UPDATE listing_video SET next_attempt_at = $2::timestamptz WHERE id = $1::uuid", [id, nextIso]); },
    async pullForward(jobId, nowIso) {
      await db.query("UPDATE listing_video SET next_attempt_at = $2::timestamptz WHERE provider_job_id = $1 AND status = 'processing' AND archived_at IS NULL", [jobId, nowIso]);
    },
    async markReady(id, key, contentType, nowIso) {
      await db.query("UPDATE listing_video SET status = 'ready', storage_key = $2, content_type = $3, generated_at = $4::timestamptz, error = '' WHERE id = $1::uuid AND status IN ('queued','processing')", [id, key, contentType, nowIso]);
    },
    async scheduleRetry(id, attempts, nextIso, error) {
      await db.query("UPDATE listing_video SET status = 'queued', provider_job_id = NULL, attempts = $2, next_attempt_at = $3::timestamptz, error = $4 WHERE id = $1::uuid", [id, attempts, nextIso, error.slice(0, 500)]);
    },
    markFailed: (id, error, nowIso, audit) => atomic(db, async tx => {
      const r = await one("UPDATE listing_video SET status = 'failed', error = $2 WHERE id = $1::uuid AND status IN ('queued','processing') RETURNING team_id, cost_cents, model", [id, error.slice(0, 500)], tx);
      if (!r) return;
      if (r["model"] === "team" && r["team_id"]) await tx.query(INSERT_LEDGER_SQL, [randomUUID(), s(r["team_id"]), id, "refund", -Number(r["cost_cents"]), nowIso]);
      await appendAuditPg(tx, audit);
    }),
    async createPurchase(p) {
      await db.query("INSERT INTO video_purchase (id, listing_id, buyer_id, amount_cents) VALUES ($1::uuid,$2::uuid,$3::uuid,$4)", [p.id, p.listingId, p.buyerId, p.amountCents]);
    },
    async attachCheckout(purchaseId, sessionId) { await db.query("UPDATE video_purchase SET checkout_session_id = $2 WHERE id = $1::uuid", [purchaseId, sessionId]); },
    async purchaseBySession(sessionId) { const r = await one(`SELECT ${PURCHASE_COLS} FROM video_purchase WHERE checkout_session_id = $1`, [sessionId]); return r ? toPurchase(r) : undefined; },
    async hasPaid(listingId, buyerId) { return !!(await one("SELECT 1 FROM video_purchase WHERE listing_id = $1::uuid AND buyer_id = $2::uuid AND status = 'paid'", [listingId, buyerId])); },
    settlePurchase: (eventId, purchaseId, videoId, nowIso, audit) => atomic(db, async tx => {
      if ((await tx.query("INSERT INTO video_webhook_event (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id", [eventId])).rows.length === 0) return false;
      await tx.query("UPDATE video_purchase SET status = 'paid', video_id = $2::uuid, paid_at = $3::timestamptz WHERE id = $1::uuid AND status = 'pending'", [purchaseId, videoId, nowIso]);
      await appendAuditPg(tx, audit);
      return true;
    }),
    async expirePurchase(sessionId) { await db.query("UPDATE video_purchase SET status = 'expired' WHERE checkout_session_id = $1 AND status = 'pending'", [sessionId]); },
    async appendAudit(e: AuditEvent) { await appendAuditPg(db, e); }
  };
}

export const videoIds: VideoIds = { newId: () => randomUUID(), now: () => new Date().toISOString() };
export const getVideoRepo = () => createPgVideoRepository(getDb());
export const getVideoProvider = (): VideoProvider => hedraVideoFromEnv();
export const getCheckout = (): CheckoutPort => stripeCheckoutFromEnv();
export const getVideoStorage = () => objectStorageFromEnv(process.env);
export const runQueueNow = (limit?: number) => runVideoQueue({ repo: getVideoRepo(), provider: getVideoProvider(), storage: getVideoStorage(), ids: videoIds }, limit);
/** Best effort straight after a request, so the video starts without waiting for the scheduler. Never throws. */
export const kickQueue = () => runQueueNow(3).catch(() => undefined);

export interface WebhookReply { status: number; body: Record<string, unknown> }
const MAX_BODY_BYTES = 256 * 1024;

/** Stripe webhook for video payments. Fails closed while STRIPE_VIDEO_WEBHOOK_SECRET is unset; the signature is the authentication. */
export async function handleVideoStripeWebhook(repo: VideoRepository, rawBody: string, signature: string | null, secret: string | undefined, ids: VideoIds): Promise<WebhookReply> {
  if (!secret) return { status: 503, body: { error: "Video payments are not enabled." } };
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { status: 413, body: { error: "Too large." } };
  if (!stripeSignatureValid(rawBody, signature, secret)) return { status: 401, body: { error: "Invalid signature." } };
  const e = parseCheckoutEvent(rawBody);
  if (e === null) return { status: 400, body: { error: "Invalid event." } };
  if (e === undefined) return { status: 200, body: { ok: true, note: "Event type ignored." } };
  if (e.kind === "expired") { await repo.expirePurchase(e.sessionId); return { status: 200, body: { ok: true } }; }
  return { status: 200, body: { ok: true, result: await completeBuyerPurchase(repo, e.eventId, e.sessionId, ids) } };
}
