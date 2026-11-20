import { randomUUID } from "node:crypto";
import {
  agreed, groupModeration, ruleText, moderationGroupKey, recommendComplaint, recommendModeration, recommendVerification,
  type ComplaintFacts, type PrescreenAction, type PrescreenQueue, type Recommendation, type StaffAction
} from "../domain/elena-prescreen";
import { appendAuditPg, type Queryable } from "./db";
import type { QueueItem } from "./moderation-queue-db";
import type { ReportRow, VerificationQueueRow } from "./contractor-trust-db";

/**
 * Storage and data gathering for Elena's staff pre-screening. Constant SQL, bound parameters only. Reads only what the rules need
 * (counts and dates, plus the text already on the queue card); nothing here is sent to a model or an outside service.
 */

const text = (v: unknown) => String(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const optIso = (v: unknown) => (v === null || v === undefined ? null : iso(v));
const num = (v: unknown) => Number(v ?? 0);

export interface Screened extends Recommendation { recommendationId: string | null }

/** Stores each recommendation once per (queue, subject, fingerprint) and returns its id. A new fingerprint (the facts changed) is a new row. */
async function logRecommendations(db: Queryable, queue: PrescreenQueue, rows: { subjectId: string; fingerprint: string; rec: Recommendation }[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (rows.length === 0) return ids;
  try {
    for (const r of rows) {
      await db.query(
        `INSERT INTO elena_staff_recommendation (queue, subject_id, fingerprint, action, confidence, rule, reason)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7) ON CONFLICT (queue, subject_id, fingerprint) DO NOTHING`,
        [queue, r.subjectId, r.fingerprint, r.rec.action, r.rec.confidence, r.rec.rule, ruleText(r.rec.rule)]);
    }
    const got = await db.query(
      "SELECT id, subject_id, fingerprint FROM elena_staff_recommendation WHERE queue = $1 AND subject_id = ANY($2::uuid[])", [queue, rows.map(r => r.subjectId)]);
    for (const g of got.rows) ids.set(`${text(g["subject_id"])}|${text(g["fingerprint"])}`, text(g["id"]));
  } catch { /* A logging failure must never hide the queue from staff; the recommendation is still shown, just without an id. */ }
  return ids;
}
const fp = (rec: Recommendation) => `${rec.rule}:${rec.action}:${rec.confidence}`;

// ---------- Moderation ----------
export async function prescreenModerationPg(db: Queryable, items: readonly QueueItem[]): Promise<Map<string, Screened>> {
  const open = items.filter(i => i.status === "open" || i.status === "escalated");
  const out = new Map<string, Screened>();
  if (open.length === 0) return out;
  const owners = [...new Set(open.map(i => i.subjectOwnerId).filter((x): x is string => !!x))];
  const rejected = new Map<string, number>();
  if (owners.length) {
    for (const r of (await db.query(
      `SELECT subject_owner_id, count(*)::int AS n FROM moderation_item WHERE status = 'rejected' AND decided_at > now() - interval '90 days' AND subject_owner_id = ANY($1::uuid[]) GROUP BY subject_owner_id`, [owners])).rows)
      rejected.set(text(r["subject_owner_id"]), num(r["n"]));
  }
  const groups = groupModeration(open.map(i => ({ id: i.id, createdAt: i.createdAt, groupKey: moderationGroupKey(i, i.subjectOwnerId) })));
  const recs = open.map(i => ({
    item: i,
    rec: recommendModeration({ id: i.id, subjectType: i.subjectType, source: i.source, reason: i.reason, detail: i.detail, severity: i.severity, hasOwner: !!i.subjectOwnerId,
      ownerRecentRejections: i.subjectOwnerId ? rejected.get(i.subjectOwnerId) ?? 0 : 0 })
  }));
  const ids = await logRecommendations(db, "moderation", recs.map(r => ({ subjectId: r.item.id, fingerprint: fp(r.rec), rec: r.rec })));
  for (const { item, rec } of recs) {
    const g = groups.get(item.id);
    out.set(item.id, {
      ...rec, recommendationId: ids.get(`${item.id}|${fp(rec)}`) ?? null,
      ...(g && g.size > 1 ? { groupSize: g.size, ...(g.leadId !== item.id ? { duplicateOf: g.leadId } : {}) } : {})
    });
  }
  return out;
}

// ---------- Verification ----------
export async function prescreenVerificationsPg(db: Queryable, rows: readonly VerificationQueueRow[], today: string): Promise<Map<string, Screened>> {
  const out = new Map<string, Screened>();
  const pending = rows.filter(r => r.status === "pending");
  if (pending.length === 0) return out;
  const users = pending.map(r => r.userId);
  const trades = new Map<string, string[]>();
  for (const r of (await db.query("SELECT user_id, kind FROM contractor_profile WHERE user_id = ANY($1::uuid[])", [users])).rows)
    trades.set(text(r["user_id"]), [...(trades.get(text(r["user_id"])) ?? []), text(r["kind"])]);
  const sameAbn = new Map<string, Set<string>>();
  for (const r of (await db.query("SELECT user_id, abn FROM contractor_verification WHERE abn = ANY($1::text[])", [pending.map(p => p.abn)])).rows) {
    const set = sameAbn.get(text(r["abn"])) ?? new Set<string>();
    set.add(text(r["user_id"])); sameAbn.set(text(r["abn"]), set);
  }
  const recs = pending.map(v => ({
    v, rec: recommendVerification({
      businessName: v.businessName, accountName: v.name, abn: v.abn, licenceNumber: v.licenceNumber, licenceAuthority: v.licenceAuthority, licenceExpiry: v.licenceExpiry,
      insurer: v.insurer, policyNumber: v.policyNumber, insuranceExpiry: v.insuranceExpiry, trades: trades.get(v.userId) ?? [],
      abnUsedByOther: [...(sameAbn.get(v.abn) ?? [])].some(u => u !== v.userId)
    }, today)
  }));
  // Details that are resubmitted keep the same user id, so the submission time is part of the fingerprint.
  const ids = await logRecommendations(db, "verification", recs.map(r => ({ subjectId: r.v.userId, fingerprint: `${fp(r.rec)}:${r.v.submittedAt}`.slice(0, 80), rec: r.rec })));
  for (const { v, rec } of recs) out.set(v.userId, { ...rec, recommendationId: ids.get(`${v.userId}|${`${fp(rec)}:${v.submittedAt}`.slice(0, 80)}`) ?? null });
  return out;
}

// ---------- Complaints ----------
export async function complaintFactsPg(db: Queryable, complaintIds: readonly string[]): Promise<Map<string, ComplaintFacts>> {
  const out = new Map<string, ComplaintFacts>();
  if (complaintIds.length === 0) return out;
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.details, c.created_at, c.reported_by, a.contractor_user_id, a.kind AS job_kind, a.status AS job_status, a.created_at AS job_created,
            a.scheduled_time, a.completed_at, a.contractor_done_at,
       (SELECT count(*) FROM job_assignment x WHERE x.contractor_user_id = a.contractor_user_id) AS jobs_total,
       (SELECT count(*) FROM job_assignment x WHERE x.contractor_user_id = a.contractor_user_id AND x.status = 'completed') AS jobs_done,
       (SELECT avg(r.rating) FROM contractor_review r WHERE r.contractor_user_id = a.contractor_user_id AND r.status = 'visible') AS avg_rating,
       (SELECT count(*) FROM contractor_review r WHERE r.contractor_user_id = a.contractor_user_id AND r.status = 'visible') AS rating_count,
       COALESCE((SELECT s.suspended FROM contractor_standing s WHERE s.user_id = a.contractor_user_id), false) AS suspended,
       (SELECT count(*) FROM contractor_complaint o JOIN job_assignment oa ON oa.id = o.assignment_id WHERE oa.contractor_user_id = a.contractor_user_id AND o.id <> c.id AND o.status = 'upheld') AS upheld,
       (SELECT count(*) FROM contractor_complaint o JOIN job_assignment oa ON oa.id = o.assignment_id WHERE oa.contractor_user_id = a.contractor_user_id AND o.id <> c.id AND o.status = 'dismissed') AS dismissed,
       (SELECT count(*) FROM contractor_complaint o JOIN job_assignment oa ON oa.id = o.assignment_id WHERE oa.contractor_user_id = a.contractor_user_id AND o.id <> c.id AND o.status = 'open') AS open_others,
       (SELECT count(*) FROM contractor_complaint o JOIN job_assignment oa ON oa.id = o.assignment_id WHERE oa.contractor_user_id = a.contractor_user_id AND o.reported_by = c.reported_by AND o.id <> c.id AND o.created_at < c.created_at) AS rep_total,
       (SELECT count(*) FROM contractor_complaint o JOIN job_assignment oa ON oa.id = o.assignment_id WHERE oa.contractor_user_id = a.contractor_user_id AND o.reported_by = c.reported_by AND o.id <> c.id AND o.created_at < c.created_at AND o.status = 'dismissed') AS rep_dismissed
     FROM contractor_complaint c JOIN job_assignment a ON a.id = c.assignment_id WHERE c.id = ANY($1::uuid[])`, [complaintIds]);
  for (const r of rows) {
    out.set(text(r["id"]), {
      kind: text(r["kind"]), detail: text(r["details"]), filedAt: iso(r["created_at"]),
      job: { kind: text(r["job_kind"]), status: text(r["job_status"]), createdAt: iso(r["job_created"]), scheduledTime: optIso(r["scheduled_time"]), completedAt: optIso(r["completed_at"]), contractorDoneAt: optIso(r["contractor_done_at"]) },
      contractor: {
        jobsTotal: num(r["jobs_total"]), jobsCompleted: num(r["jobs_done"]), averageRating: r["avg_rating"] === null ? null : Number(r["avg_rating"]), ratingCount: num(r["rating_count"]),
        suspended: r["suspended"] === true, upheldBefore: num(r["upheld"]), dismissedBefore: num(r["dismissed"]), openOthers: num(r["open_others"])
      },
      reporterEarlier: { total: num(r["rep_total"]), dismissed: num(r["rep_dismissed"]) }
    });
  }
  return out;
}

export async function prescreenComplaintsPg(db: Queryable, reports: readonly ReportRow[]): Promise<Map<string, Screened>> {
  const out = new Map<string, Screened>();
  const open = reports.filter(r => r.status === "open");
  if (open.length === 0) return out;
  const facts = await complaintFactsPg(db, open.map(r => r.id));
  const recs = open.flatMap(r => { const f = facts.get(r.id); return f ? [{ id: r.id, rec: recommendComplaint(f) }] : []; });
  const ids = await logRecommendations(db, "complaint", recs.map(r => ({ subjectId: r.id, fingerprint: fp(r.rec), rec: r.rec })));
  for (const { id, rec } of recs) out.set(id, { ...rec, recommendationId: ids.get(`${id}|${fp(rec)}`) ?? null });
  return out;
}

// ---------- Outcomes ----------
/**
 * Records what staff did with the latest recommendation Elena showed for this subject, and writes an audit event. Called after the decision
 * itself committed, and never throws: staff decisions must not fail because the accuracy log did. Returns false if logging failed.
 */
export async function logOutcomePg(db: Queryable, o: { queue: PrescreenQueue; subjectId: string; staffId: string; staffRole: string; staffAction: StaffAction; viaBulk?: boolean }): Promise<boolean> {
  try {
    const rec = (await db.query(
      "SELECT id, action, confidence, rule FROM elena_staff_recommendation WHERE queue = $1 AND subject_id = $2::uuid ORDER BY created_at DESC, id DESC LIMIT 1", [o.queue, o.subjectId])).rows[0];
    const ok = rec ? agreed(text(rec["action"]) as PrescreenAction, o.staffAction) : null;
    await db.query(
      `INSERT INTO elena_staff_outcome (recommendation_id, queue, subject_id, staff_id, staff_action, agreed, via_bulk) VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7)`,
      [rec ? text(rec["id"]) : null, o.queue, o.subjectId, o.staffId, o.staffAction, ok, o.viaBulk === true]);
    await appendAuditPg(db, {
      id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: o.staffId, aggregateType: "elena_staff_prescreen", aggregateId: o.subjectId,
      eventType: ok === false ? "elena_staff_prescreen.override" : "elena_staff_prescreen.outcome", correlationId: randomUUID(),
      payload: { role: o.staffRole, queue: o.queue, staffAction: o.staffAction, agreed: ok, viaBulk: o.viaBulk === true, ...(rec ? { recommended: text(rec["action"]), confidence: text(rec["confidence"]), rule: text(rec["rule"]) } : {}) }
    });
    return true;
  } catch { return false; }
}

/**
 * Runs `fn` while holding a per-staff advisory lock, so two bulk requests from the same person cannot both read a low hourly count.
 * The lock lives on one transaction; the decisions inside `fn` commit on their own connections. Test doubles without transactions just run `fn`.
 */
export async function withBulkLockPg<T>(db: Queryable, staffId: string, fn: () => Promise<T>): Promise<T> {
  if (!db.transaction) return fn();
  return db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`elena_bulk:${staffId}`]);
    return fn();
  });
}

/** Bulk confirms this staff member made in the last hour (the per-hour cap is checked against it). */
export async function bulkCountLastHourPg(db: Queryable, staffId: string): Promise<number> {
  const r = await db.query("SELECT count(*)::int AS n FROM elena_staff_outcome WHERE staff_id = $1::uuid AND via_bulk AND created_at > now() - interval '1 hour'", [staffId]);
  return num(r.rows[0]?.["n"]);
}

export interface AccuracyRow { queue: string; rule: string; confidence: string; total: number; agreed: number; overridden: number; neutral: number }
/** How often staff agreed with each rule over the last N days (default 30). */
export async function accuracyPg(db: Queryable, days = 30): Promise<AccuracyRow[]> {
  const d = Math.min(Math.max(Math.trunc(days) || 30, 1), 365);
  const r = await db.query(
    `SELECT o.queue, COALESCE(x.rule, 'none') AS rule, COALESCE(x.confidence, 'none') AS confidence, count(*)::int AS total,
            count(*) FILTER (WHERE o.agreed IS TRUE)::int AS agreed, count(*) FILTER (WHERE o.agreed IS FALSE)::int AS overridden, count(*) FILTER (WHERE o.agreed IS NULL)::int AS neutral
       FROM elena_staff_outcome o LEFT JOIN elena_staff_recommendation x ON x.id = o.recommendation_id
      WHERE o.created_at > now() - ($1::int * interval '1 day') GROUP BY o.queue, x.rule, x.confidence ORDER BY o.queue, total DESC`, [d]);
  return r.rows.map(x => ({ queue: text(x["queue"]), rule: text(x["rule"]), confidence: text(x["confidence"]), total: num(x["total"]), agreed: num(x["agreed"]), overridden: num(x["overridden"]), neutral: num(x["neutral"]) }));
}
