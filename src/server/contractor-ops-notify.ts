import { readBrand } from "../config/brand";
import { tenantNoticeEmail, type TenantNoticeInput } from "../domain/contractor-ops";
import type { Kind } from "../domain/notifications";
import { JURISDICTION_TIME_ZONE } from "../domain/timezone";
import type { Jurisdiction } from "../domain/jurisdiction";
import { whenText } from "../domain/open-inspection";
import { getJobPrefs, insertTenantNotice, recentNoticeCount, type JobContext } from "./contractor-ops-db";
import type { Queryable } from "./db";
import { getEmailPort } from "./messaging";
import { notifyUser } from "./notifier";
import { withinRates } from "./rate-guard";

type Env = Readonly<Record<string, string | undefined>>;

const zoneOf = (jurisdiction: string) => JURISDICTION_TIME_ZONE[jurisdiction as Jurisdiction] ?? "Australia/Sydney";
export const visitWhen = (startsAt: string, endsAt: string, jurisdiction: string): string => {
  const tz = zoneOf(jurisdiction);
  const end = new Intl.DateTimeFormat("en-AU", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(endsAt));
  return `${whenText(startsAt, tz)} to ${end}`;
};

/** At most this many job alerts per person per hour on email and SMS. In-app always goes. */
export const JOB_ALERTS_PER_HOUR = 20;

/**
 * Tells one party about a job. In-app always. A contractor's email and text follow their own job preferences (read now, so a change applies at once),
 * on top of the account-wide notification settings, which can only narrow it further. Never throws: an alert must not block the action behind it.
 */
export async function notifyJobParty(
  db: Queryable, userId: string, isContractor: boolean, kind: Extract<Kind, "job_new" | "job_time_changed" | "job_reminder">,
  params: { listing: string; job: string; when?: string; name?: string; link: string }, env: Env = process.env
): Promise<void> {
  try {
    const p = { ...params, ...(params.when ? { when: params.when } : {}) };
    await notifyUser(db, userId, kind, p, env, "in_app");
    const prefs = isContractor ? await getJobPrefs(db, userId) : { email: true, sms: false, reminderHours: 24 };
    if (!prefs.email && !prefs.sms) return;
    if (!(await withinRates(db, "job-alert", [userId], { windowMs: 3_600_000, limit: JOB_ALERTS_PER_HOUR }))) return;
    if (prefs.email) await notifyUser(db, userId, kind, p, env, "email");
    if (prefs.sms) await notifyUser(db, userId, kind, p, env, "sms");
  } catch {
    // Nothing identifying is logged.
  }
}

/** The owner proposed (or changed) a time: tell the contractor. The contractor proposed: tell the owner. */
export async function notifyTimeProposed(db: Queryable, job: JobContext, proposerId: string, startsAt: string, endsAt: string, env: Env = process.env): Promise<void> {
  const toContractor = proposerId === job.ownerId;
  const target = toContractor ? job.contractorId : job.ownerId;
  await notifyJobParty(db, target, toContractor, "job_time_changed", {
    listing: toContractor && job.status !== "approved" ? "a property" : job.address, job: job.kind,
    when: visitWhen(startsAt, endsAt, job.jurisdiction), link: toContractor ? "/contractor/calendar" : `/jobs/${job.id}/visit`
  }, env);
}

export async function notifyNewJob(db: Queryable, contractorId: string, listingTitle: string, kind: string, assignmentId: string, env: Env = process.env): Promise<void> {
  // The address stays hidden until the contractor accepts: the title only.
  await notifyJobParty(db, contractorId, true, "job_new", { listing: listingTitle, job: kind, link: `/jobs/${assignmentId}/visit` }, env);
}

export type TenantNoticeResult = { ok: true } | { ok: false; code: "rate_limited" | "unavailable"; message: string };

/**
 * Emails the tenant the entry window and logs it. Email only: a tenant is not a user and gets no text message. Limits: 3 notices per job per
 * day and 10 per owner per hour. If email is not set up, nothing is logged as sent and the owner is told.
 */
export async function sendTenantNotice(db: Queryable, job: JobContext, n: TenantNoticeInput, env: Env = process.env): Promise<TenantNoticeResult> {
  if (await recentNoticeCount(db, job.id) >= 3) return { ok: false, code: "rate_limited", message: "Three notices have already gone out for this job today." };
  if (!(await withinRates(db, "tenant-notice", [job.ownerId], { windowMs: 3_600_000, limit: 10 }))) return { ok: false, code: "rate_limited", message: "Too many notices. Try again later." };
  const port = await getEmailPort(db, env, "job_tenant_notice");
  if (!port.configured) return { ok: false, code: "unavailable", message: "Email is not set up yet, so the notice could not be sent." };
  const mail = tenantNoticeEmail({
    tenantName: n.tenantName, address: job.address, kind: job.kind, contractorName: job.contractorName,
    when: visitWhen(n.startsAt, n.endsAt, job.jurisdiction), ownerName: job.ownerName, brand: readBrand().name
  });
  const sent = (await port.send({ to: n.tenantEmail, subject: mail.subject, text: mail.text })).status === "sent";
  await insertTenantNotice(db, { assignmentId: job.id, name: n.tenantName, email: n.tenantEmail, startsAt: n.startsAt, endsAt: n.endsAt, sentBy: job.ownerId, status: sent ? "sent" : "failed" });
  return sent ? { ok: true } : { ok: false, code: "unavailable", message: "The email could not be sent. Try again shortly." };
}

export const REMINDERS_SQL =
  "SELECT v.assignment_id, v.starts_at, v.ends_at, a.contractor_user_id, a.kind, l.address_text, l.jurisdiction FROM job_visit v " +
  "JOIN job_assignment a ON a.id = v.assignment_id JOIN property_listing l ON l.id = a.listing_id " +
  "LEFT JOIN contractor_job_pref p ON p.user_id = a.contractor_user_id " +
  "WHERE v.state = 'confirmed' AND a.status = 'approved' AND v.reminder_sent_at IS NULL AND v.starts_at > $1::timestamptz " +
  "AND COALESCE(p.reminder_hours, 24) > 0 AND v.starts_at <= $1::timestamptz + make_interval(hours => COALESCE(p.reminder_hours, 24)) ORDER BY v.starts_at LIMIT 200";
/** Claims the reminder before sending, so two scheduler runs never send it twice. */
export const CLAIM_REMINDER_SQL = "UPDATE job_visit SET reminder_sent_at = now() WHERE assignment_id = $1::uuid AND reminder_sent_at IS NULL RETURNING assignment_id";

/** Run by a scheduler (hourly is enough). Reminds each contractor once per confirmed visit, as early as their own setting says. */
export async function runJobReminders(db: Queryable, nowIso: string, env: Env = process.env): Promise<{ sent: number }> {
  const due = (await db.query(REMINDERS_SQL, [nowIso])).rows;
  let sent = 0;
  for (const r of due) {
    const id = String(r["assignment_id"]);
    if ((await db.query(CLAIM_REMINDER_SQL, [id])).rows.length !== 1) continue;
    await notifyJobParty(db, String(r["contractor_user_id"]), true, "job_reminder", {
      listing: String(r["address_text"]), job: String(r["kind"]), link: "/contractor/calendar",
      when: visitWhen(new Date(r["starts_at"] as string).toISOString(), new Date(r["ends_at"] as string).toISOString(), String(r["jurisdiction"]).trim())
    }, env);
    sent += 1;
  }
  return { sent };
}
