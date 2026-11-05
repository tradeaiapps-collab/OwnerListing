import { randomUUID } from "node:crypto";
import { readBrand } from "../config/brand";
import { nextTaskRun, type Cadence, type TaskInput, type TaskKind } from "../domain/scheduled-tasks";
import { appendAuditPg, type Queryable } from "./db";
import { sendNotice } from "./messaging";
import { runInviteReminders } from "./notifier";

type Env = Readonly<Record<string, string | undefined>>;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : new Date(String(v)).toISOString());

export interface TaskRow extends TaskInput { id: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null; lastDetail: string | null; createdAt: string }
const toTask = (x: Record<string, unknown>): TaskRow => ({
  id: String(x["id"]), name: String(x["name"]), kind: String(x["kind"]) as TaskKind, config: (x["config"] ?? {}) as TaskInput["config"], cadence: String(x["cadence"]) as Cadence,
  hour: Number(x["hour"]), weekday: x["weekday"] === null ? null : Number(x["weekday"]), dayOfMonth: x["day_of_month"] === null ? null : Number(x["day_of_month"]), runAt: iso(x["run_at"]),
  enabled: Boolean(x["enabled"]), nextRunAt: iso(x["next_run_at"]), lastRunAt: iso(x["last_run_at"]), lastStatus: x["last_status"] === null ? null : String(x["last_status"]),
  lastDetail: x["last_detail"] === null ? null : String(x["last_detail"]), createdAt: iso(x["created_at"])!
});

export async function listTasksPg(db: Queryable): Promise<TaskRow[]> {
  return (await db.query("SELECT * FROM scheduled_task ORDER BY created_at DESC LIMIT 200")).rows.map(toTask);
}
export async function createTaskPg(db: Queryable, t: TaskInput, by: string, nowIso: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO scheduled_task (name, kind, config, cadence, hour, weekday, day_of_month, run_at, next_run_at, created_by)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10::uuid) RETURNING id`,
    [t.name, t.kind, JSON.stringify(t.config), t.cadence, t.hour, t.weekday, t.dayOfMonth, t.runAt, nextTaskRun(t, nowIso), by]);
  return String(r.rows[0]!["id"]);
}
export async function setTaskEnabledPg(db: Queryable, id: string, enabled: boolean, nowIso: string): Promise<boolean> {
  const t = (await db.query("SELECT * FROM scheduled_task WHERE id = $1::uuid", [id])).rows[0];
  if (!t) return false;
  const row = toTask(t);
  // Switching back on never replays missed runs: the next run is the next one from now (a finished one-off stays finished).
  const next = enabled ? nextTaskRun(row, nowIso, row.lastRunAt !== null && row.cadence === "once") : row.nextRunAt;
  await db.query("UPDATE scheduled_task SET enabled = $2, next_run_at = $3 WHERE id = $1::uuid", [id, enabled, next]);
  return true;
}
/** A task that has run is only switched off (its runs are history); one that never ran can be removed. */
export async function deleteTaskPg(db: Queryable, id: string, nowIso: string): Promise<"deleted" | "disabled" | "missing"> {
  const used = await db.query("SELECT 1 FROM scheduled_task_run WHERE task_id = $1::uuid LIMIT 1", [id]);
  if (used.rows.length > 0) return (await setTaskEnabledPg(db, id, false, nowIso)) ? "disabled" : "missing";
  return (await db.query("DELETE FROM scheduled_task WHERE id = $1::uuid RETURNING id", [id])).rows.length > 0 ? "deleted" : "missing";
}
export async function recentTaskRunsPg(db: Queryable, limit = 30): Promise<{ id: string; taskId: string; taskName: string; startedAt: string; status: string; affected: number; detail: string | null; source: string }[]> {
  const r = await db.query(
    `SELECT r.*, t.name FROM scheduled_task_run r JOIN scheduled_task t ON t.id = r.task_id ORDER BY r.started_at DESC LIMIT $1`, [limit]);
  return r.rows.map(x => ({ id: String(x["id"]), taskId: String(x["task_id"]), taskName: String(x["name"]), startedAt: iso(x["started_at"])!, status: String(x["status"]),
    affected: Number(x["affected"]), detail: x["detail"] === null ? null : String(x["detail"]), source: String(x["trigger_source"]) }));
}

/** What a task does. Returns how many records it changed or sent, and a one-line note. */
async function perform(db: Queryable, t: TaskRow, createdBy: string, nowIso: string, env: Env): Promise<{ affected: number; detail: string }> {
  if (t.kind === "archive_stale_listings") {
    const days = t.config.days ?? 365;
    const ids = await db.query(
      `UPDATE property_listing SET status = 'archived', updated_at = now()
        WHERE id IN (SELECT id FROM property_listing WHERE status IN ('draft','withdrawn') AND deleted_at IS NULL AND updated_at <= $1::timestamptz - make_interval(days => $2::int)
                      ORDER BY updated_at LIMIT 500)
        RETURNING id`, [nowIso, days]);
    for (const r of ids.rows) {
      await appendAuditPg(db, { id: randomUUID(), occurredAt: nowIso, actorType: "system", actorId: "scheduled-tasks", aggregateType: "property_listing", aggregateId: String(r["id"]),
        eventType: "listing.archived_by_schedule", correlationId: randomUUID(), payload: { taskId: t.id, idleDays: days } });
    }
    return { affected: ids.rows.length, detail: `Archived ${ids.rows.length} listing(s) idle for ${days}+ days.` };
  }
  if (t.kind === "invite_reminders") {
    const r = await runInviteReminders(db, nowIso, env);
    return { affected: r.reminded, detail: `Sent ${r.reminded} reminder(s).` };
  }
  const days = t.config.days ?? 7;
  const q = async (sql: string) => Number((await db.query(sql, [nowIso, days])).rows[0]?.["n"] ?? 0);
  const win = "BETWEEN $1::timestamptz - make_interval(days => $2::int) AND $1::timestamptz";
  const [published, offers, users, live] = await Promise.all([
    q(`SELECT count(*)::int AS n FROM property_listing WHERE status = 'published' AND created_at ${win}`),
    q(`SELECT count(*)::int AS n FROM formal_offer WHERE submitted_at ${win}`),
    q(`SELECT count(*)::int AS n FROM app_user WHERE user_type <> 'admin' AND created_at ${win}`),
    Number((await db.query("SELECT count(*)::int AS n FROM property_listing WHERE status = 'published' AND deleted_at IS NULL")).rows[0]?.["n"] ?? 0)
  ]);
  const text = `${readBrand().name} summary for the last ${days} day(s):\n- New published listings: ${published}\n- Offers made: ${offers}\n- New accounts: ${users}\n- Live listings now: ${live}\n`;
  const who = (await db.query("SELECT email FROM app_user WHERE id = $1::uuid AND status = 'active'", [createdBy])).rows[0]?.["email"];
  const sent = typeof who === "string" ? await sendNotice(db, "scheduled_summary", who, { subject: `${readBrand().name} summary: last ${days} day(s)`, text }, env) : false;
  return { affected: sent ? 1 : 0, detail: `${published} listings, ${offers} offers, ${users} new accounts, ${live} live.${sent ? " Emailed." : " Email not sent (not configured or no address)."}` };
}

async function execute(db: Queryable, t: TaskRow, source: "schedule" | "manual", nowIso: string, env: Env): Promise<void> {
  let status: "ok" | "failed" = "ok", affected = 0, detail = "";
  try {
    const owner = (await db.query("SELECT created_by FROM scheduled_task WHERE id = $1::uuid", [t.id])).rows[0]?.["created_by"];
    ({ affected, detail } = await perform(db, t, String(owner), nowIso, env));
  } catch {
    status = "failed"; detail = "The task failed; it will try again at its next run.";
  }
  await db.query("INSERT INTO scheduled_task_run (task_id, started_at, status, affected, detail, trigger_source) VALUES ($1::uuid,$2::timestamptz,$3,$4,$5,$6)", [t.id, nowIso, status, affected, detail, source]);
  await appendAuditPg(db, { id: randomUUID(), occurredAt: nowIso, actorType: "system", actorId: "scheduled-tasks", aggregateType: "scheduled_task", aggregateId: t.id,
    eventType: "job.scheduled_task_run", correlationId: randomUUID(), payload: { kind: t.kind, status, affected, source } });
  if (source === "schedule") {
    const next = nextTaskRun(t, nowIso, true);
    await db.query("UPDATE scheduled_task SET last_run_at=$2::timestamptz, last_status=$3, last_detail=$4, next_run_at=$5, enabled = enabled AND $5::timestamptz IS NOT NULL WHERE id=$1::uuid", [t.id, nowIso, status, detail, next]);
  } else {
    await db.query("UPDATE scheduled_task SET last_run_at=$2::timestamptz, last_status=$3, last_detail=$4 WHERE id=$1::uuid", [t.id, nowIso, status, detail]);
  }
}

/** "Run now" from the screen. Does not move the schedule. */
export async function runTaskNowPg(db: Queryable, id: string, nowIso: string, env: Env): Promise<boolean> {
  const x = (await db.query("SELECT * FROM scheduled_task WHERE id = $1::uuid", [id])).rows[0];
  if (!x) return false;
  await execute(db, toTask(x), "manual", nowIso, env);
  return true;
}

/** Runs every enabled task that is due. A task is claimed by moving its next run forward first, so overlapping ticks never run it twice. */
export async function runDueTasks(db: Queryable, nowIso: string, env: Env, limit = 20): Promise<{ due: number; ok: number; failed: number }> {
  const due = (await db.query("SELECT * FROM scheduled_task WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1::timestamptz ORDER BY next_run_at LIMIT $2", [nowIso, limit])).rows.map(toTask);
  const out = { due: due.length, ok: 0, failed: 0 };
  for (const t of due) {
    const claim = await db.query("UPDATE scheduled_task SET next_run_at = NULL WHERE id = $1::uuid AND next_run_at = $2::timestamptz RETURNING id", [t.id, t.nextRunAt]);
    if (claim.rows.length === 0) continue;
    await execute(db, t, "schedule", nowIso, env);
    const after = (await db.query("SELECT last_status FROM scheduled_task WHERE id = $1::uuid", [t.id])).rows[0]?.["last_status"];
    if (after === "failed") out.failed++; else out.ok++;
  }
  return out;
}
