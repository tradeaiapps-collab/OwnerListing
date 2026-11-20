import { randomUUID } from "node:crypto";
import { MessagingKeyError, openSetting, sealSetting } from "../domain/messaging-crypto";
import type { AccessInput, AccessMethod, ComplaintKind, ContractorFacts, JobPrefs, Slot, Visit, VisitInput } from "../domain/contractor-ops";
import { defaultJobPrefs } from "../domain/contractor-ops";
import type { Queryable } from "./db";

// Constant SQL; user input only travels as bound parameters. Every read is scoped to a party of the job (owner or contractor on the
// assignment row) and every write checks the same thing in its WHERE clause. Nothing here deletes a row.

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const str = (v: unknown) => String(v);

export interface JobContext {
  id: string; listingId: string; ownerId: string; contractorId: string; kind: string; status: string;
  role: "owner" | "contractor"; address: string; jurisdiction: string; ownerName: string; contractorName: string;
}

export const JOB_CONTEXT_SQL =
  "SELECT a.id, a.listing_id, a.owner_user_id, a.contractor_user_id, a.kind, a.status, l.address_text, l.jurisdiction, " +
  "ou.display_name AS owner_name, cu.display_name AS contractor_name " +
  "FROM job_assignment a JOIN property_listing l ON l.id = a.listing_id " +
  "JOIN app_user ou ON ou.id = a.owner_user_id JOIN app_user cu ON cu.id = a.contractor_user_id " +
  "WHERE a.id = $1::uuid AND (a.owner_user_id = $2::uuid OR a.contractor_user_id = $2::uuid)";

/** The job, only if `userId` is its owner or its contractor. Anyone else gets undefined (the route answers 404). */
export async function getJobContext(db: Queryable, assignmentId: string, userId: string): Promise<JobContext | undefined> {
  const r = (await db.query(JOB_CONTEXT_SQL, [assignmentId, userId])).rows[0];
  if (!r) return undefined;
  return {
    id: str(r["id"]), listingId: str(r["listing_id"]), ownerId: str(r["owner_user_id"]), contractorId: str(r["contractor_user_id"]),
    kind: str(r["kind"]), status: str(r["status"]), role: str(r["owner_user_id"]) === userId ? "owner" : "contractor",
    address: str(r["address_text"]), jurisdiction: str(r["jurisdiction"]).trim(), ownerName: str(r["owner_name"]), contractorName: str(r["contractor_name"])
  };
}

/** One audit row per action. Payloads never hold access details, addresses or emails. */
export async function auditJob(db: Queryable, actorId: string, assignmentId: string, eventType: string, payload: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    "INSERT INTO audit_event (id, occurred_at, actor_type, actor_id, aggregate_type, aggregate_id, event_type, correlation_id, payload) " +
    "VALUES ($1::uuid, now(), 'user', $2::text, 'job_assignment', $3::text, $4::text, $5::text, $6::jsonb)",
    [randomUUID(), actorId, assignmentId, eventType, randomUUID(), JSON.stringify(payload)]);
}

// ---- Visit -------------------------------------------------------------------------------------------------------------------------
const visitOf = (r: Record<string, unknown>): Visit => ({
  assignmentId: str(r["assignment_id"]), startsAt: iso(r["starts_at"]), endsAt: iso(r["ends_at"]), state: str(r["state"]) as Visit["state"],
  proposedBy: str(r["proposed_by"]), attendees: (r["attendees"] as string[]) as Visit["attendees"]
});
const VISIT_COLS = "assignment_id, starts_at, ends_at, state, proposed_by, attendees";

export async function getVisit(db: Queryable, assignmentId: string): Promise<Visit | undefined> {
  const r = (await db.query(`SELECT ${VISIT_COLS} FROM job_visit WHERE assignment_id = $1::uuid`, [assignmentId])).rows[0];
  return r ? visitOf(r) : undefined;
}

/** Sets or replaces the proposed time. A new proposal always needs the other side's confirmation and re-arms the reminder. Only while the job is open. */
export const UPSERT_VISIT_SQL =
  "INSERT INTO job_visit (assignment_id, starts_at, ends_at, state, proposed_by, attendees) " +
  "SELECT a.id, $2::timestamptz, $3::timestamptz, 'proposed', $4::uuid, $5::text[] FROM job_assignment a " +
  "WHERE a.id = $1::uuid AND a.status IN ('proposed','approved') AND (a.owner_user_id = $4::uuid OR a.contractor_user_id = $4::uuid) " +
  "ON CONFLICT (assignment_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, state = 'proposed', " +
  "proposed_by = EXCLUDED.proposed_by, attendees = EXCLUDED.attendees, reminder_sent_at = NULL, updated_at = now() RETURNING assignment_id";
export async function proposeVisit(db: Queryable, assignmentId: string, proposerId: string, v: VisitInput): Promise<boolean> {
  return (await db.query(UPSERT_VISIT_SQL, [assignmentId, v.startsAt, v.endsAt, proposerId, v.attendees])).rows.length === 1;
}

/** Confirms the other side's proposal. The proposer cannot confirm their own time. */
export const CONFIRM_VISIT_SQL =
  "UPDATE job_visit v SET state = 'confirmed', updated_at = now() FROM job_assignment a WHERE v.assignment_id = $1::uuid AND a.id = v.assignment_id " +
  "AND a.status IN ('proposed','approved') AND v.state = 'proposed' AND v.proposed_by <> $2::uuid " +
  "AND (a.owner_user_id = $2::uuid OR a.contractor_user_id = $2::uuid) RETURNING v.assignment_id";
export async function confirmVisit(db: Queryable, assignmentId: string, userId: string): Promise<boolean> {
  return (await db.query(CONFIRM_VISIT_SQL, [assignmentId, userId])).rows.length === 1;
}

/** Times of the contractor's accepted jobs, for the double-booking check. Proposed jobs are not commitments yet. */
export const COMMITTED_SLOTS_SQL =
  "SELECT v.assignment_id, v.starts_at, v.ends_at FROM job_visit v JOIN job_assignment a ON a.id = v.assignment_id " +
  "WHERE a.contractor_user_id = $1::uuid AND a.status = 'approved' AND v.ends_at > now() ORDER BY v.starts_at LIMIT 500";
export async function committedSlots(db: Queryable, contractorId: string): Promise<Slot[]> {
  return (await db.query(COMMITTED_SLOTS_SQL, [contractorId])).rows.map(r => ({ assignmentId: str(r["assignment_id"]), startsAt: iso(r["starts_at"]), endsAt: iso(r["ends_at"]) }));
}

export interface CalendarItem {
  assignmentId: string; kind: string; status: string; listingTitle: string; address: string | null; startsAt: string; endsAt: string;
  visitState: "proposed" | "confirmed"; attendees: string[];
}
/**
 * The contractor's own jobs that have a time. The full address is shown only for an accepted job: a job still waiting for an answer shows the
 * listing title alone.
 */
export const CALENDAR_SQL =
  "SELECT a.id, a.kind, a.status, l.title, l.address_text, v.starts_at, v.ends_at, v.state, v.attendees " +
  "FROM job_visit v JOIN job_assignment a ON a.id = v.assignment_id JOIN property_listing l ON l.id = a.listing_id " +
  "WHERE a.contractor_user_id = $1::uuid AND a.status IN ('proposed','approved') AND v.ends_at > now() - interval '1 day' " +
  "ORDER BY v.starts_at LIMIT 200";
export async function contractorCalendar(db: Queryable, contractorId: string): Promise<CalendarItem[]> {
  return (await db.query(CALENDAR_SQL, [contractorId])).rows.map(r => ({
    assignmentId: str(r["id"]), kind: str(r["kind"]), status: str(r["status"]), listingTitle: str(r["title"]),
    address: str(r["status"]) === "approved" ? str(r["address_text"]) : null, startsAt: iso(r["starts_at"]), endsAt: iso(r["ends_at"]),
    visitState: str(r["state"]) as CalendarItem["visitState"], attendees: r["attendees"] as string[]
  }));
}

// ---- Access ------------------------------------------------------------------------------------------------------------------------
const accessField = (assignmentId: string) => `job-access:${assignmentId}`;
export type AccessSaved = { ok: true } | { ok: false; reason: "key_missing" | "not_allowed" };

/** Seals the details first. Without MESSAGING_SETTINGS_KEY nothing secret is stored (fail closed). Only the job's owner while the job is open. */
export const SAVE_ACCESS_SQL =
  "INSERT INTO job_access (assignment_id, method, sealed_details, updated_by) " +
  "SELECT a.id, $2::text, $3::text, $4::uuid FROM job_assignment a WHERE a.id = $1::uuid AND a.owner_user_id = $4::uuid AND a.status IN ('proposed','approved') " +
  "ON CONFLICT (assignment_id) DO UPDATE SET method = EXCLUDED.method, sealed_details = EXCLUDED.sealed_details, updated_by = EXCLUDED.updated_by, updated_at = now() " +
  "RETURNING assignment_id";
export async function saveAccess(db: Queryable, assignmentId: string, ownerId: string, a: AccessInput, key: string | undefined): Promise<AccessSaved> {
  let sealed: string | null = null;
  if (a.details !== null) {
    try { sealed = await sealSetting(a.details, key, accessField(assignmentId)); }
    catch (e) { if (e instanceof MessagingKeyError) return { ok: false, reason: "key_missing" }; throw e; }
  }
  const r = await db.query(SAVE_ACCESS_SQL, [assignmentId, a.method, sealed, ownerId]);
  return r.rows.length === 1 ? { ok: true } : { ok: false, reason: "not_allowed" };
}

/** The stored method and the opened details. Opening fails closed: a tampered or wrong-key value reads as "no details". */
export async function loadAccess(db: Queryable, assignmentId: string, key: string | undefined): Promise<{ method: AccessMethod; details: string | null } | undefined> {
  const r = (await db.query("SELECT method, sealed_details FROM job_access WHERE assignment_id = $1::uuid", [assignmentId])).rows[0];
  if (!r) return undefined;
  let details: string | null = null;
  if (typeof r["sealed_details"] === "string") {
    try { details = (await openSetting(r["sealed_details"], key, accessField(assignmentId))) ?? null; } catch { details = null; }
  }
  return { method: str(r["method"]) as AccessMethod, details };
}

// ---- Tenant notice -----------------------------------------------------------------------------------------------------------------
export interface TenantNoticeRow { id: string; tenantName: string; windowStartsAt: string; windowEndsAt: string; status: "sent" | "failed"; sentAt: string }
export async function listTenantNotices(db: Queryable, assignmentId: string): Promise<TenantNoticeRow[]> {
  const r = await db.query(
    "SELECT id, tenant_name, window_starts_at, window_ends_at, status, sent_at FROM job_tenant_notice WHERE assignment_id = $1::uuid ORDER BY sent_at DESC LIMIT 20", [assignmentId]);
  return r.rows.map(x => ({ id: str(x["id"]), tenantName: str(x["tenant_name"]), windowStartsAt: iso(x["window_starts_at"]), windowEndsAt: iso(x["window_ends_at"]), status: str(x["status"]) as "sent" | "failed", sentAt: iso(x["sent_at"]) }));
}
export async function recentNoticeCount(db: Queryable, assignmentId: string): Promise<number> {
  const r = await db.query("SELECT count(*)::int AS n FROM job_tenant_notice WHERE assignment_id = $1::uuid AND sent_at > now() - interval '1 day'", [assignmentId]);
  return Number(r.rows[0]?.["n"] ?? 0);
}
export async function insertTenantNotice(db: Queryable, p: { assignmentId: string; name: string; email: string; startsAt: string; endsAt: string; sentBy: string; status: "sent" | "failed" }): Promise<void> {
  await db.query(
    "INSERT INTO job_tenant_notice (assignment_id, tenant_name, tenant_email, window_starts_at, window_ends_at, sent_by, status) VALUES ($1::uuid,$2,$3,$4::timestamptz,$5::timestamptz,$6::uuid,$7)",
    [p.assignmentId, p.name, p.email, p.startsAt, p.endsAt, p.sentBy, p.status]);
}

// ---- Complaints and preferences ----------------------------------------------------------------------------------------------------
/** Only the owner of an accepted or finished job can report on it. */
export const INSERT_COMPLAINT_SQL =
  "INSERT INTO contractor_complaint (assignment_id, reported_by, kind, details) SELECT a.id, a.owner_user_id, $3::text, $4::text FROM job_assignment a " +
  "WHERE a.id = $1::uuid AND a.owner_user_id = $2::uuid AND (a.status IN ('approved','completed') OR a.approved_at IS NOT NULL) RETURNING id";
export async function insertComplaint(db: Queryable, assignmentId: string, ownerId: string, kind: ComplaintKind, details: string): Promise<boolean> {
  return (await db.query(INSERT_COMPLAINT_SQL, [assignmentId, ownerId, kind, details])).rows.length === 1;
}

export async function getJobPrefs(db: Queryable, userId: string): Promise<JobPrefs> {
  const r = (await db.query("SELECT email, sms, reminder_hours FROM contractor_job_pref WHERE user_id = $1::uuid", [userId])).rows[0];
  return r ? { email: r["email"] === true, sms: r["sms"] === true, reminderHours: Number(r["reminder_hours"]) } : defaultJobPrefs();
}
export async function saveJobPrefs(db: Queryable, userId: string, p: JobPrefs): Promise<void> {
  await db.query(
    "INSERT INTO contractor_job_pref (user_id, email, sms, reminder_hours) VALUES ($1::uuid,$2,$3,$4) " +
    "ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, sms = EXCLUDED.sms, reminder_hours = EXCLUDED.reminder_hours, updated_at = now()",
    [userId, p.email, p.sms, p.reminderHours]);
}

// ---- Staff report ------------------------------------------------------------------------------------------------------------------
/**
 * Per contractor, for jobs invited in [from, to) (the invitation's audit time). Response time is invitation to first answer (accept or
 * decline). Complaints are counted on those same jobs. Params: 1 from, 2 to.
 */
export const REPORT_SQL =
  "WITH inv AS (SELECT aggregate_id AS aid, min(occurred_at) AS invited_at FROM audit_event WHERE aggregate_type = 'job_assignment' " +
  "AND event_type = 'assignment.invited' AND occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz GROUP BY aggregate_id), " +
  "ans AS (SELECT aggregate_id AS aid, min(occurred_at) AS answered_at, bool_or(event_type = 'assignment.declined') AS declined FROM audit_event " +
  "WHERE aggregate_type = 'job_assignment' AND event_type IN ('assignment.accepted','assignment.declined') GROUP BY aggregate_id), " +
  "cmp AS (SELECT assignment_id, count(*) AS n FROM contractor_complaint GROUP BY assignment_id) " +
  "SELECT a.contractor_user_id AS id, u.display_name AS name, count(*)::int AS invited, " +
  "count(*) FILTER (WHERE a.approved_at IS NOT NULL)::int AS accepted, " +
  "count(*) FILTER (WHERE COALESCE(ans.declined, false))::int AS declined, " +
  "count(*) FILTER (WHERE a.status = 'completed')::int AS completed, " +
  "count(*) FILTER (WHERE a.status = 'cancelled' AND a.approved_at IS NOT NULL)::int AS cancelled_after, " +
  "COALESCE(sum(EXTRACT(EPOCH FROM (ans.answered_at - inv.invited_at)) / 60) FILTER (WHERE ans.answered_at IS NOT NULL), 0)::float AS response_minutes, " +
  "count(*) FILTER (WHERE ans.answered_at IS NOT NULL)::int AS responses, COALESCE(sum(cmp.n), 0)::int AS complaints " +
  "FROM inv JOIN job_assignment a ON a.id::text = inv.aid JOIN app_user u ON u.id = a.contractor_user_id " +
  "LEFT JOIN ans ON ans.aid = inv.aid LEFT JOIN cmp ON cmp.assignment_id = a.id " +
  "GROUP BY a.contractor_user_id, u.display_name ORDER BY complaints DESC, invited DESC LIMIT 500";
/** `to` is an inclusive date, so the query runs to the start of the next day. */
export async function loadContractorFacts(db: Queryable, from: string, to: string): Promise<ContractorFacts[]> {
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString();
  const r = await db.query(REPORT_SQL, [`${from}T00:00:00Z`, end]);
  return r.rows.map(x => ({
    contractorId: str(x["id"]), name: str(x["name"]), invited: Number(x["invited"]), accepted: Number(x["accepted"]), declined: Number(x["declined"]),
    completed: Number(x["completed"]), cancelledAfterAccept: Number(x["cancelled_after"]), responseMinutesTotal: Number(x["response_minutes"]),
    responses: Number(x["responses"]), complaints: Number(x["complaints"])
  }));
}
