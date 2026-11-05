import { nextRunAfter, type ReportSchedule } from "./saved-reports";

/** Scheduled bulk actions. Pure validation and timing; the work itself is in src/server/scheduled-tasks-db.ts. Times are Brisbane time. */
export const TASK_KINDS = ["archive_stale_listings", "invite_reminders", "platform_summary"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const CADENCES = ["once", "daily", "weekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];
export const TASK_INFO: Record<TaskKind, { label: string; help: string }> = {
  archive_stale_listings: { label: "Archive old listings", help: "Archives draft and withdrawn listings not touched for N days. Published listings are never archived by a schedule." },
  invite_reminders: { label: "Send reminders", help: "Reminds agents of appointment invitations that have waited 48 hours for an answer." },
  platform_summary: { label: "Send a summary", help: "Emails a summary of listings, offers and new accounts for the last N days to the staff member who created it." }
};
export interface TaskInput { name: string; kind: TaskKind; config: { days?: number }; cadence: Cadence; hour: number; weekday: number | null; dayOfMonth: number | null; runAt: string | null }

const int = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);

export function parseTask(input: unknown, nowIso: string): { ok: true; value: TaskInput } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Send the task as an object." };
  const o = input as Record<string, unknown>;
  const name = typeof o["name"] === "string" ? o["name"].trim() : "";
  if (name.length < 3 || name.length > 120) return { ok: false, error: "Give the task a name of 3 to 120 characters." };
  const kind = TASK_KINDS.find(k => k === o["kind"]);
  if (!kind) return { ok: false, error: "Choose what the task does." };
  const cadence = CADENCES.find(c => c === o["cadence"]);
  if (!cadence) return { ok: false, error: "Choose how often it runs." };
  const config: TaskInput["config"] = {};
  const cfg = (o["config"] ?? {}) as Record<string, unknown>;
  if (kind === "archive_stale_listings") {
    const days = int(cfg["days"], 30, 1825);
    if (days === null) return { ok: false, error: "Choose how many idle days (30 to 1825)." };
    config.days = days;
  }
  if (kind === "platform_summary") {
    const days = int(cfg["days"] ?? 7, 1, 90);
    if (days === null) return { ok: false, error: "Choose a summary period of 1 to 90 days." };
    config.days = days;
  }
  const hour = int(o["hour"] ?? 9, 0, 23);
  if (hour === null) return { ok: false, error: "Choose an hour from 0 to 23." };
  let weekday: number | null = null, dayOfMonth: number | null = null, runAt: string | null = null;
  if (cadence === "weekly") { weekday = int(o["weekday"] ?? 1, 1, 7); if (weekday === null) return { ok: false, error: "Choose a weekday." }; }
  if (cadence === "monthly") { dayOfMonth = int(o["dayOfMonth"] ?? 1, 1, 28); if (dayOfMonth === null) return { ok: false, error: "Choose a day of the month from 1 to 28." }; }
  if (cadence === "once") {
    const t = Date.parse(String(o["runAt"] ?? ""));
    if (Number.isNaN(t)) return { ok: false, error: "Choose when it runs." };
    if (t < Date.parse(nowIso) - 60_000) return { ok: false, error: "Choose a time in the future." };
    runAt = new Date(t).toISOString();
  }
  return { ok: true, value: { name, kind, config, cadence, hour, weekday, dayOfMonth, runAt } };
}

/** The next time this task is due after `nowIso`, or null for a one-off that already ran. */
export function nextTaskRun(t: Pick<TaskInput, "cadence" | "hour" | "weekday" | "dayOfMonth" | "runAt">, nowIso: string, ranOnce = false): string | null {
  if (t.cadence === "once") return ranOnce ? null : t.runAt;
  const s: ReportSchedule = { frequency: t.cadence, hour: t.hour, weekday: t.weekday ?? 1, dayOfMonth: t.dayOfMonth ?? 1 };
  return nextRunAfter(s, nowIso);
}

export function describeTask(t: Pick<TaskInput, "cadence" | "hour" | "weekday" | "dayOfMonth" | "runAt">): string {
  const hh = `${String(t.hour).padStart(2, "0")}:00`;
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  if (t.cadence === "once") return `Once, ${t.runAt ?? "unscheduled"}`;
  if (t.cadence === "daily") return `Every day at ${hh} Brisbane time`;
  if (t.cadence === "weekly") return `Every ${days[(t.weekday ?? 1) - 1]} at ${hh} Brisbane time`;
  return `On day ${t.dayOfMonth ?? 1} of each month at ${hh} Brisbane time`;
}
