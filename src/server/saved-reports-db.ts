import type { Insights } from "../domain/report-insights";
import type { ReportDefinition, ReportResult, ReportSchedule } from "../domain/saved-reports";
import type { Queryable } from "./db";

export interface SavedReportRow {
  id: string; ownerUserId: string; definition: ReportDefinition; shared: boolean; createdAt: string; updatedAt: string;
  schedule: (ReportSchedule & { enabled: boolean; nextRunAt: string; lastRunAt: string | null; lastStatus: string | null }) | null;
  lastRunAt: string | null;
}
export interface RunSummary { id: string; trigger: string; periodFrom: string; periodTo: string; createdAt: string }

const SELECT = `SELECT r.id, r.owner_user_id, r.definition, r.shared, r.created_at, r.updated_at,
       s.frequency, s.weekday, s.day_of_month, s.hour, s.enabled, s.next_run_at, s.last_run_at, s.last_status,
       (SELECT max(created_at) FROM report_run x WHERE x.report_id = r.id) AS last_run
  FROM saved_report r LEFT JOIN report_schedule s ON s.report_id = r.id`;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);

function toRow(r: Record<string, unknown>): SavedReportRow {
  return {
    id: String(r["id"]), ownerUserId: String(r["owner_user_id"]), definition: r["definition"] as ReportDefinition, shared: r["shared"] === true,
    createdAt: iso(r["created_at"])!, updatedAt: iso(r["updated_at"])!,
    schedule: r["frequency"] ? {
      frequency: r["frequency"] as ReportSchedule["frequency"], weekday: Number(r["weekday"]), dayOfMonth: Number(r["day_of_month"]), hour: Number(r["hour"]),
      enabled: r["enabled"] === true, nextRunAt: iso(r["next_run_at"])!, lastRunAt: iso(r["last_run_at"]), lastStatus: (r["last_status"] as string | null) ?? null
    } : null,
    lastRunAt: iso(r["last_run"])
  };
}

/** Reports the staff member can open: their own, plus shared ones. Newest first. */
export async function listReports(db: Queryable, userId: string): Promise<SavedReportRow[]> {
  const res = await db.query(`${SELECT} WHERE r.archived_at IS NULL AND (r.owner_user_id = $1::uuid OR r.shared) ORDER BY r.created_at DESC LIMIT 200`, [userId]);
  return res.rows.map(toRow);
}

export async function getReport(db: Queryable, id: string): Promise<SavedReportRow | null> {
  const res = await db.query(`${SELECT} WHERE r.id = $1::uuid AND r.archived_at IS NULL`, [id]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

const MAX_REPORTS_PER_OWNER = 100;

/** Creates a report (and its schedule, if any). Returns null when the owner already has the maximum number. */
export async function createReport(db: Queryable, ownerId: string, def: ReportDefinition, schedule: { s: ReportSchedule; nextRunAt: string } | null): Promise<string | null> {
  const count = await db.query("SELECT count(*)::int AS n FROM saved_report WHERE owner_user_id = $1::uuid AND archived_at IS NULL", [ownerId]);
  if (Number(count.rows[0]?.["n"] ?? 0) >= MAX_REPORTS_PER_OWNER) return null;
  const res = await db.query("INSERT INTO saved_report (owner_user_id, name, definition, shared) VALUES ($1::uuid, $2, $3::jsonb, $4) RETURNING id",
    [ownerId, def.name, JSON.stringify(def), def.shared]);
  const id = String(res.rows[0]!["id"]);
  if (schedule) await setSchedule(db, id, schedule.s, schedule.nextRunAt);
  return id;
}

export async function updateReport(db: Queryable, id: string, ownerId: string, def: ReportDefinition): Promise<boolean> {
  const res = await db.query(
    "UPDATE saved_report SET name = $3, definition = $4::jsonb, shared = $5, updated_at = now() WHERE id = $1::uuid AND owner_user_id = $2::uuid AND archived_at IS NULL RETURNING id",
    [id, ownerId, def.name, JSON.stringify(def), def.shared]);
  return res.rows.length > 0;
}

export async function setSchedule(db: Queryable, id: string, s: ReportSchedule, nextRunAt: string): Promise<void> {
  await db.query(
    `INSERT INTO report_schedule (report_id, frequency, weekday, day_of_month, hour, enabled, next_run_at) VALUES ($1::uuid, $2, $3, $4, $5, true, $6::timestamptz)
     ON CONFLICT (report_id) DO UPDATE SET frequency = $2, weekday = $3, day_of_month = $4, hour = $5, enabled = true, next_run_at = $6::timestamptz, last_status = NULL`,
    [id, s.frequency, s.weekday, s.dayOfMonth, s.hour, nextRunAt]);
}

export async function clearSchedule(db: Queryable, id: string): Promise<void> {
  await db.query("DELETE FROM report_schedule WHERE report_id = $1::uuid", [id]);
}

/** Soft delete: the report and its run history stay for the audit trail, and its schedule stops. */
export async function archiveReport(db: Queryable, id: string, ownerId: string): Promise<boolean> {
  const res = await db.query("UPDATE saved_report SET archived_at = now() WHERE id = $1::uuid AND owner_user_id = $2::uuid AND archived_at IS NULL RETURNING id", [id, ownerId]);
  if (res.rows.length === 0) return false;
  await clearSchedule(db, id);
  return true;
}

const MAX_RUNS_PER_REPORT = 60;

export async function recordRun(db: Queryable, reportId: string, trigger: "manual" | "schedule", runBy: string | null, result: ReportResult, insights: Insights): Promise<string> {
  const res = await db.query(
    "INSERT INTO report_run (report_id, trigger, run_by, period_from, period_to, result, insights) VALUES ($1::uuid, $2, $3::uuid, $4::date, $5::date, $6::jsonb, $7::jsonb) RETURNING id",
    [reportId, trigger, runBy, result.range.from, result.range.to, JSON.stringify(result), JSON.stringify(insights)]);
  // History is capped so a daily schedule cannot grow without bound; the oldest snapshots go first.
  await db.query(
    "DELETE FROM report_run WHERE report_id = $1::uuid AND id NOT IN (SELECT id FROM report_run WHERE report_id = $1::uuid ORDER BY created_at DESC, id LIMIT $2)",
    [reportId, MAX_RUNS_PER_REPORT]);
  return String(res.rows[0]!["id"]);
}

export async function listRuns(db: Queryable, reportId: string): Promise<RunSummary[]> {
  const res = await db.query("SELECT id, trigger, period_from::text AS f, period_to::text AS t, created_at FROM report_run WHERE report_id = $1::uuid ORDER BY created_at DESC LIMIT 60", [reportId]);
  return res.rows.map(r => ({ id: String(r["id"]), trigger: String(r["trigger"]), periodFrom: String(r["f"]), periodTo: String(r["t"]), createdAt: iso(r["created_at"])! }));
}

export async function getRun(db: Queryable, reportId: string, runId: string): Promise<{ result: ReportResult; insights: Insights } | null> {
  const res = await db.query("SELECT result, insights FROM report_run WHERE id = $1::uuid AND report_id = $2::uuid", [runId, reportId]);
  const r = res.rows[0];
  return r ? { result: r["result"] as ReportResult, insights: r["insights"] as Insights } : null;
}

export interface DueSchedule { reportId: string; ownerId: string; definition: ReportDefinition; schedule: ReportSchedule; nextRunAt: string; ownerEmail: string | null }

export async function dueSchedules(db: Queryable, nowIso: string, limit: number): Promise<DueSchedule[]> {
  const res = await db.query(
    `SELECT r.id, r.owner_user_id, r.definition, s.frequency, s.weekday, s.day_of_month, s.hour, s.next_run_at, u.email::text AS email
       FROM report_schedule s JOIN saved_report r ON r.id = s.report_id AND r.archived_at IS NULL JOIN app_user u ON u.id = r.owner_user_id
      WHERE s.enabled AND s.next_run_at <= $1::timestamptz ORDER BY s.next_run_at LIMIT $2`, [nowIso, limit]);
  return res.rows.map(r => ({
    reportId: String(r["id"]), ownerId: String(r["owner_user_id"]), definition: r["definition"] as ReportDefinition,
    schedule: { frequency: r["frequency"] as ReportSchedule["frequency"], weekday: Number(r["weekday"]), dayOfMonth: Number(r["day_of_month"]), hour: Number(r["hour"]) },
    nextRunAt: iso(r["next_run_at"])!, ownerEmail: typeof r["email"] === "string" ? r["email"] : null
  }));
}

/** Takes a due schedule by moving next_run_at forward; only one caller can win, so a run is never sent twice. */
export async function claimSchedule(db: Queryable, d: DueSchedule, nextRunAt: string): Promise<boolean> {
  const res = await db.query("UPDATE report_schedule SET next_run_at = $3::timestamptz WHERE report_id = $1::uuid AND next_run_at = $2::timestamptz AND enabled RETURNING report_id",
    [d.reportId, d.nextRunAt, nextRunAt]);
  return res.rows.length > 0;
}

export async function finishSchedule(db: Queryable, reportId: string, status: "sent" | "not_configured" | "failed" | "owner_no_access", nowIso: string): Promise<void> {
  await db.query("UPDATE report_schedule SET last_run_at = $2::timestamptz, last_status = $3, enabled = (enabled AND $3 <> 'owner_no_access') WHERE report_id = $1::uuid", [reportId, nowIso, status]);
}
