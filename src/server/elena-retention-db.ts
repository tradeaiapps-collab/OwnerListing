import { randomUUID } from "node:crypto";
import { appendAuditPg, type Queryable } from "./db";

export const RETENTION_MIN_DAYS = 90, RETENTION_MAX_DAYS = 3650;
export interface RetentionSettings { enabled: boolean; retentionDays: number; lastRunAt: string | null }
export interface RetentionCounts { applications: number; enquiryActions: number }
export interface RetentionRun extends RetentionCounts { id: string; trigger: "staff" | "schedule"; retentionDays: number; ranAt: string }

export const validRetentionDays = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= RETENTION_MIN_DAYS && (n as number) <= RETENTION_MAX_DAYS;

const iso = (v: unknown) => (v ? new Date(v as string | Date).toISOString() : null);

export async function getRetentionSettings(db: Queryable): Promise<RetentionSettings> {
  const r = (await db.query("SELECT enabled, retention_days, last_run_at FROM elena_retention_settings WHERE singleton")).rows[0]!;
  return { enabled: r["enabled"] === true, retentionDays: Number(r["retention_days"]), lastRunAt: iso(r["last_run_at"]) };
}

export async function saveRetentionSettings(db: Queryable, staffId: string, s: { enabled: boolean; retentionDays: number }): Promise<void> {
  await db.query("UPDATE elena_retention_settings SET enabled = $1, retention_days = $2, updated_by = $3::uuid, updated_at = now() WHERE singleton", [s.enabled, s.retentionDays, staffId]);
  await audit(db, staffId, "elena_retention.settings_changed", { enabled: s.enabled, retentionDays: s.retentionDays });
}

// Constant SQL, parameters only. An application is stale once nothing has changed for the whole period.
const APP_STALE = "purged_at IS NULL AND COALESCE(decided_at, updated_at) < $1::timestamptz AND updated_at < $1::timestamptz";
const ACT_STALE = "purged_at IS NULL AND created_at < $1::timestamptz";
const cutoff = (nowIso: string, days: number) => new Date(Date.parse(nowIso) - days * 86_400_000).toISOString();

/** How many records a purge would scrub right now. Reads only. */
export async function previewRetention(db: Queryable, nowIso: string, days: number): Promise<RetentionCounts> {
  const c = cutoff(nowIso, days);
  const a = await db.query(`SELECT count(*)::int AS n FROM rental_application WHERE ${APP_STALE}`, [c]);
  const e = await db.query(`SELECT count(*)::int AS n FROM elena_enquiry_action WHERE ${ACT_STALE}`, [c]);
  return { applications: Number(a.rows[0]!["n"]), enquiryActions: Number(e.rows[0]!["n"]) };
}

/**
 * Scrubs applicant data older than the period: income, history, references, move-in date and the applicant's note on rental applications, and
 * the draft text and topics of Elena's enquiry actions. Rows, statuses and ids stay so counts and history still add up. Chat and Elena message
 * records are never deletable and are not touched. One statement per table, so a repeat or overlapping run scrubs nothing twice. Always audited.
 */
export async function runRetentionPurge(db: Queryable, nowIso: string, days: number, by: { trigger: "staff"; staffId: string } | { trigger: "schedule" }): Promise<RetentionCounts> {
  if (!validRetentionDays(days)) throw new Error("invalid retention period");
  const c = cutoff(nowIso, days);
  const a = await db.query(
    `UPDATE rental_application SET weekly_income_cents = NULL, rental_history_months = NULL, references_count = NULL, move_in_date = NULL, note = NULL, purged_at = $2::timestamptz
     WHERE ${APP_STALE} RETURNING id`, [c, nowIso]);
  const e = await db.query(`UPDATE elena_enquiry_action SET body = NULL, topics = '{}', purged_at = $2::timestamptz WHERE ${ACT_STALE} RETURNING id`, [c, nowIso]);
  const counts = { applications: a.rows.length, enquiryActions: e.rows.length };
  const staffId = by.trigger === "staff" ? by.staffId : null;
  await db.query(
    "INSERT INTO elena_retention_run (trigger, staff_id, retention_days, applications_scrubbed, enquiry_actions_scrubbed, ran_at) VALUES ($1, $2::uuid, $3, $4, $5, $6::timestamptz)",
    [by.trigger, staffId, days, counts.applications, counts.enquiryActions, nowIso]);
  await db.query("UPDATE elena_retention_settings SET last_run_at = $1::timestamptz WHERE singleton", [nowIso]);
  await audit(db, staffId ?? "automation", "elena_retention.purged", { trigger: by.trigger, retentionDays: days, ...counts }, staffId ? "user" : "system");
  return counts;
}

/** Scheduled part of the automation tick: runs at most once a day, and only while staff have switched retention on. */
export async function runScheduledRetention(db: Queryable, nowIso: string): Promise<RetentionCounts | null> {
  const s = await getRetentionSettings(db);
  if (!s.enabled) return null;
  if (s.lastRunAt && Date.parse(nowIso) - Date.parse(s.lastRunAt) < 86_400_000) return null;
  return runRetentionPurge(db, nowIso, s.retentionDays, { trigger: "schedule" });
}

export async function recentRetentionRuns(db: Queryable, limit = 10): Promise<RetentionRun[]> {
  const rows = (await db.query("SELECT id, trigger, retention_days, applications_scrubbed, enquiry_actions_scrubbed, ran_at FROM elena_retention_run ORDER BY ran_at DESC LIMIT $1", [limit])).rows;
  return rows.map(r => ({ id: String(r["id"]), trigger: r["trigger"] as "staff" | "schedule", retentionDays: Number(r["retention_days"]), applications: Number(r["applications_scrubbed"]), enquiryActions: Number(r["enquiry_actions_scrubbed"]), ranAt: iso(r["ran_at"])! }));
}

async function audit(db: Queryable, actorId: string, eventType: string, payload: Record<string, unknown>, actorType: "user" | "system" = "user") {
  await appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType, actorId, aggregateType: "elena_retention", aggregateId: "settings", eventType, correlationId: randomUUID(), payload });
}
