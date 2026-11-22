import type { Failure, Result } from "./listing-service";

/**
 * Contractor operations: the visit time, how the contractor gets in, who attends, entry notice to a tenant,
 * alert preferences, complaints and the staff report. Pure functions, no I/O.
 */

const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

export const HOUR_MS = 3_600_000;
export const MIN_VISIT_MINUTES = 15;
export const MAX_VISIT_HOURS = 12;
export const MAX_DAYS_AHEAD = 365;
/** A tenant must be told at least this long before anyone enters. A platform minimum: the law differs by state and kind of entry. */
export const TENANT_NOTICE_MIN_HOURS = 24;

// ---- Visit time and attendees ------------------------------------------------------------------------------------------------------
export const ATTENDEES = ["owner", "agent", "tenant"] as const;
export type Attendee = (typeof ATTENDEES)[number];
export interface VisitInput { startsAt: string; endsAt: string; attendees: Attendee[] }
export interface Visit extends VisitInput { assignmentId: string; state: "proposed" | "confirmed"; proposedBy: string }

/** An ISO time that carries an explicit offset (a bare local time would silently mean the server's zone). */
function parseInstant(v: unknown): number | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

export function parseAttendees(v: unknown): Attendee[] | undefined {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > ATTENDEES.length) return undefined;
  const out: Attendee[] = [];
  for (const a of v) {
    if (!(ATTENDEES as readonly unknown[]).includes(a)) return undefined;
    if (!out.includes(a as Attendee)) out.push(a as Attendee);
  }
  return out;
}

/** Body: { startsAt, endsAt, attendees? }. The time must be in the future, at least 15 minutes and at most 12 hours long. */
export function parseVisitInput(input: unknown, nowIso: string): Result<VisitInput> {
  const o = obj(input);
  if (!o) return bad("Send a JSON object.");
  const s = parseInstant(o["startsAt"]);
  const e = parseInstant(o["endsAt"]);
  if (s === undefined || e === undefined) return bad("Give a start and end time with a time zone, like 2026-12-01T09:00:00+10:00.");
  const now = Date.parse(nowIso);
  if (s <= now) return bad("Choose a time in the future.");
  if (s > now + MAX_DAYS_AHEAD * 24 * HOUR_MS) return bad("Choose a time within the next year.");
  if (e - s < MIN_VISIT_MINUTES * 60_000) return bad(`A visit must be at least ${MIN_VISIT_MINUTES} minutes.`);
  if (e - s > MAX_VISIT_HOURS * HOUR_MS) return bad(`A visit can be at most ${MAX_VISIT_HOURS} hours.`);
  const attendees = parseAttendees(o["attendees"]);
  if (!attendees) return bad("Attendees can be owner, agent or tenant.");
  return { ok: true, value: { startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), attendees } };
}

export interface Slot { assignmentId: string; startsAt: string; endsAt: string }
export const overlaps = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }): boolean =>
  Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);

/** The other jobs that clash with this one. A job never clashes with itself. */
export const findOverlaps = (candidate: Slot, others: readonly Slot[]): Slot[] =>
  others.filter(o => o.assignmentId !== candidate.assignmentId && overlaps(candidate, o));

// ---- Access ------------------------------------------------------------------------------------------------------------------------
export const ACCESS_METHODS = ["owner_present", "agent_present", "tenant_present", "key_handover", "lockbox", "open_site"] as const;
export type AccessMethod = (typeof ACCESS_METHODS)[number];
export const ACCESS_LABELS: Record<AccessMethod, string> = {
  owner_present: "The owner will let you in", agent_present: "The agent will let you in", tenant_present: "The tenant will let you in",
  key_handover: "Key handover", lockbox: "Lockbox", open_site: "Open site, no key needed"
};
/** Methods that carry a secret or a place to collect something. */
export const NEEDS_DETAILS: ReadonlySet<AccessMethod> = new Set<AccessMethod>(["key_handover", "lockbox"]);
export const MAX_ACCESS_DETAILS = 500;

export interface AccessInput { method: AccessMethod; details: string | null }
export function parseAccessInput(input: unknown): Result<AccessInput> {
  const o = obj(input);
  if (!o) return bad("Send a JSON object.");
  const method = o["method"];
  if (!(ACCESS_METHODS as readonly unknown[]).includes(method)) return bad("Choose how the contractor gets in.");
  const m = method as AccessMethod;
  const details = clean(o["details"], MAX_ACCESS_DETAILS + 1);
  if (details.length > MAX_ACCESS_DETAILS) return bad(`Keep the details under ${MAX_ACCESS_DETAILS} characters.`);
  if (NEEDS_DETAILS.has(m) && details === "") return bad("Say where the key is or give the lockbox code.");
  return { ok: true, value: { method: m, details: NEEDS_DETAILS.has(m) ? details : null } };
}

/** Details are only ever shown to the owner, or to the contractor while the job is accepted and not yet finished. */
export const canSeeAccessDetails = (role: "owner" | "contractor", status: string): boolean => role === "owner" || status === "approved";

export interface AccessView { method: AccessMethod; label: string; hasDetails: boolean; details: string | null; masked: boolean }
export function accessView(method: AccessMethod, details: string | null, role: "owner" | "contractor", status: string): AccessView {
  const show = details !== null && canSeeAccessDetails(role, status);
  return { method, label: ACCESS_LABELS[method], hasDetails: details !== null, details: show ? details : null, masked: details !== null && !show };
}

// ---- Tenant notice -----------------------------------------------------------------------------------------------------------------
export interface TenantNoticeInput { tenantName: string; tenantEmail: string; startsAt: string; endsAt: string }
export function parseTenantNotice(input: unknown, nowIso: string): Result<TenantNoticeInput> {
  const o = obj(input);
  if (!o) return bad("Send a JSON object.");
  const tenantName = clean(o["tenantName"], 100);
  const tenantEmail = clean(o["tenantEmail"], 254).toLowerCase();
  if (tenantName === "") return bad("Enter the tenant's name.");
  if (!EMAIL.test(tenantEmail)) return bad("Enter a valid email address for the tenant.");
  const s = parseInstant(o["startsAt"]);
  const e = parseInstant(o["endsAt"]);
  if (s === undefined || e === undefined) return bad("Give the entry window with a time zone.");
  if (e <= s || e - s > MAX_VISIT_HOURS * HOUR_MS) return bad(`The entry window must be up to ${MAX_VISIT_HOURS} hours long.`);
  if (s < Date.parse(nowIso) + TENANT_NOTICE_MIN_HOURS * HOUR_MS) return bad(`Give the tenant at least ${TENANT_NOTICE_MIN_HOURS} hours' notice.`);
  return { ok: true, value: { tenantName, tenantEmail, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() } };
}

/** Wording for the tenant. The contractor's name and trade are shared; no phone, email or access code is. */
export function tenantNoticeEmail(p: { tenantName: string; address: string; kind: string; contractorName: string; when: string; ownerName: string; brand: string }): { subject: string; text: string } {
  return {
    subject: `Entry notice: ${p.address}`,
    text:
      `Hello ${p.tenantName},\n\n` +
      `${p.ownerName}, the owner of ${p.address}, has arranged for a ${p.kind} (${p.contractorName}) to visit the property.\n\n` +
      `Entry window: ${p.when}\n\n` +
      `If this time does not suit you, please contact the owner or your property manager as soon as you can so another time can be agreed. ` +
      `This notice was sent through ${p.brand} on the owner's behalf.`
  };
}

// ---- Complaints --------------------------------------------------------------------------------------------------------------------
export const COMPLAINT_KINDS = ["no_show", "poor_work", "late", "conduct", "other"] as const;
export type ComplaintKind = (typeof COMPLAINT_KINDS)[number];
export function parseComplaint(input: unknown): Result<{ kind: ComplaintKind; details: string }> {
  const o = obj(input);
  if (!o) return bad("Send a JSON object.");
  if (!(COMPLAINT_KINDS as readonly unknown[]).includes(o["kind"])) return bad("Choose what went wrong.");
  const details = clean(o["details"], 2000);
  if (details === "") return bad("Tell us what happened.");
  return { ok: true, value: { kind: o["kind"] as ComplaintKind, details } };
}

// ---- Alert preferences -------------------------------------------------------------------------------------------------------------
export const REMINDER_HOURS = [0, 2, 24, 48] as const;
export interface JobPrefs { email: boolean; sms: boolean; reminderHours: number }
export const defaultJobPrefs = (): JobPrefs => ({ email: true, sms: false, reminderHours: 24 });
export function parseJobPrefs(input: unknown): Result<JobPrefs> {
  const o = obj(input);
  if (!o || typeof o["email"] !== "boolean" || typeof o["sms"] !== "boolean") return bad("Send email and sms as true or false.");
  const h = o["reminderHours"];
  if (typeof h !== "number" || !(REMINDER_HOURS as readonly number[]).includes(h)) return bad("Reminder must be off, 2, 24 or 48 hours before.");
  return { ok: true, value: { email: o["email"], sms: o["sms"], reminderHours: h } };
}

// ---- Staff report ------------------------------------------------------------------------------------------------------------------
export interface ContractorFacts {
  contractorId: string; name: string; invited: number; accepted: number; declined: number; completed: number; cancelledAfterAccept: number;
  /** Total minutes between invitation and the first answer, and how many answers that covers. */
  responseMinutesTotal: number; responses: number; complaints: number;
}
export interface ContractorRow extends ContractorFacts { avgResponseMinutes: number | null; completionRate: number | null; acceptRate: number | null }

const rate = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
export function buildContractorRows(facts: readonly ContractorFacts[]): ContractorRow[] {
  return facts.map(f => ({
    ...f,
    avgResponseMinutes: f.responses > 0 ? Math.round(f.responseMinutesTotal / f.responses) : null,
    completionRate: rate(f.completed, f.accepted),
    acceptRate: rate(f.accepted, f.invited)
  })).sort((a, b) => b.complaints - a.complaints || b.invited - a.invited || a.name.localeCompare(b.name));
}

export const REPORT_RANGE_MAX_DAYS = 366;
/** ?from=YYYY-MM-DD&to=YYYY-MM-DD, inclusive. Both default to the last 90 days. */
export function parseReportRange(from: string | null, to: string | null, today: string): Result<{ from: string; to: string }> {
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
  const t = to ?? today;
  const f = from ?? new Date(Date.parse(`${t}T00:00:00Z`) - 89 * 86_400_000).toISOString().slice(0, 10);
  if (!ok(f) || !ok(t)) return bad("Dates must look like 2026-11-20.");
  if (f > t) return bad("The start date must not be after the end date.");
  if ((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000 > REPORT_RANGE_MAX_DAYS) return bad(`Choose a range of up to ${REPORT_RANGE_MAX_DAYS} days.`);
  return { ok: true, value: { from: f, to: t } };
}

export function reportCsv(rows: readonly ContractorRow[], label: (name: string, i: number) => string): { header: string[]; rows: (string | number)[][] } {
  return {
    header: ["Contractor", "Invited", "Accepted", "Declined", "Completed", "Cancelled after accepting", "Avg response (minutes)", "Accept rate %", "Completion rate %", "Complaints"],
    rows: rows.map((r, i) => [label(r.name, i), r.invited, r.accepted, r.declined, r.completed, r.cancelledAfterAccept,
      r.avgResponseMinutes ?? "", r.acceptRate ?? "", r.completionRate ?? "", r.complaints])
  };
}
