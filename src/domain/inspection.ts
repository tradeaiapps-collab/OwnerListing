/**
 * Inspections and walkthroughs on a listing: who may do what, when, and a plain summary of what an inspector found.
 * Pure functions. The database and the routes live in src/server/transaction-db.ts and app/api.
 */
export const INSPECTION_KINDS = ["building", "pest", "pool", "strata", "walkthrough", "other"] as const;
export type InspectionKind = (typeof INSPECTION_KINDS)[number];
export const isInspectionKind = (v: unknown): v is InspectionKind => typeof v === "string" && (INSPECTION_KINDS as readonly string[]).includes(v);

export const INSPECTION_STATUSES = ["requested", "confirmed", "completed", "cancelled"] as const;
export type InspectionStatus = (typeof INSPECTION_STATUSES)[number];

export const SEVERITIES = ["info", "minor", "major", "urgent"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const isSeverity = (v: unknown): v is Severity => typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);

export const KIND_LABELS: Record<InspectionKind, string> = {
  building: "Building inspection", pest: "Pest inspection", pool: "Pool safety inspection", strata: "Strata inspection",
  walkthrough: "Walkthrough", other: "Other inspection"
};

export type InspectionRole = "owner" | "agent" | "inspector" | "buyer";
export type InspectionAction = "confirm" | "cancel" | "complete";

export interface InspectionRecord {
  id: string;
  listingId: string;
  kind: InspectionKind;
  requestedBy: string;
  inspectorUserId?: string | undefined;
  buyerUserId?: string | undefined;
  scheduledStart: string;
  durationMinutes: number;
  status: InspectionStatus;
  accessNotes?: string | undefined;
  cancelReason?: string | undefined;
  completedAt?: string | undefined;
}

export interface Finding { severity: Severity; area: string; summary: string; recommendation?: string | undefined }

export const LIMITS = { notes: 500, reason: 300, area: 80, summary: 500, recommendation: 500, findings: 50 } as const;
const MIN_LEAD_MS = 60 * 60 * 1000;
const MAX_LEAD_MS = 180 * 24 * 60 * 60 * 1000;
/** Control characters, angle brackets and braces never belong in these short notes. */
const PLAIN = /^[^\u0000-\u0008\u000b-\u001f\u007f<>{}`]*$/;

export const plainText = (v: unknown, max: number, required: boolean): string | null | undefined => {
  if (v === undefined || v === null || v === "") return required ? undefined : null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return required ? undefined : null;
  return t.length <= max && PLAIN.test(t) ? t : undefined;
};

export interface ScheduleInput {
  kind: InspectionKind;
  scheduledStart: string;
  durationMinutes: number;
  inspectorUserId?: string | undefined;
  buyerUserId?: string | undefined;
  accessNotes?: string | undefined;
}

/** Checks a request body. Returns the cleaned input or the problems found. Times are ISO strings, checked against `nowIso`. */
export function parseSchedule(body: unknown, nowIso: string): { ok: true; value: ScheduleInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!isInspectionKind(b["kind"])) errors.push("Choose a type of inspection.");
  const startMs = typeof b["scheduledStart"] === "string" ? Date.parse(b["scheduledStart"]) : NaN;
  const now = Date.parse(nowIso);
  if (!Number.isFinite(startMs)) errors.push("Choose a date and time.");
  else if (startMs < now + MIN_LEAD_MS) errors.push("Choose a time at least an hour from now.");
  else if (startMs > now + MAX_LEAD_MS) errors.push("Choose a time within the next 6 months.");
  const dur = b["durationMinutes"];
  if (typeof dur !== "number" || !Number.isInteger(dur) || dur < 15 || dur > 480) errors.push("Duration must be between 15 minutes and 8 hours.");
  const notes = plainText(b["accessNotes"], LIMITS.notes, false);
  if (notes === undefined) errors.push(`Access notes can be up to ${LIMITS.notes} plain characters.`);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const k of ["inspectorUserId", "buyerUserId"] as const) {
    if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== "string" || !uuid.test(b[k] as string))) errors.push(`${k} is not valid.`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      kind: b["kind"] as InspectionKind,
      scheduledStart: new Date(startMs).toISOString(),
      durationMinutes: dur as number,
      ...(typeof b["inspectorUserId"] === "string" ? { inspectorUserId: b["inspectorUserId"] } : {}),
      ...(typeof b["buyerUserId"] === "string" ? { buyerUserId: b["buyerUserId"] } : {}),
      ...(notes ? { accessNotes: notes } : {})
    }
  };
}

/** Which roles may take which action, and from which status. A walkthrough with no inspector is handled by the owner or agent. */
export function nextStatus(
  insp: Pick<InspectionRecord, "status" | "inspectorUserId" | "kind">, action: InspectionAction, role: InspectionRole, nowIso: string, startIso: string
): { ok: true; status: InspectionStatus } | { ok: false; message: string } {
  const handlers: InspectionRole[] = insp.inspectorUserId ? ["inspector", "owner", "agent"] : ["owner", "agent"];
  if (action === "confirm") {
    if (insp.status !== "requested") return { ok: false, message: "Only a requested inspection can be confirmed." };
    if (!(insp.inspectorUserId ? role === "inspector" : handlers.includes(role))) return { ok: false, message: "Only the inspector can confirm this inspection." };
    return { ok: true, status: "confirmed" };
  }
  if (action === "cancel") {
    if (insp.status !== "requested" && insp.status !== "confirmed") return { ok: false, message: "This inspection can no longer be cancelled." };
    return { ok: true, status: "cancelled" };
  }
  if (insp.status !== "confirmed") return { ok: false, message: "Confirm the inspection before completing it." };
  if (!handlers.includes(role)) return { ok: false, message: "Only the inspector can complete this inspection." };
  if (Date.parse(startIso) > Date.parse(nowIso)) return { ok: false, message: "An inspection can be completed once it has started." };
  return { ok: true, status: "completed" };
}

export function parseFindings(body: unknown): { ok: true; value: Finding[] } | { ok: false; errors: string[] } {
  if (body === undefined || body === null) return { ok: true, value: [] };
  if (!Array.isArray(body) || body.length > LIMITS.findings) return { ok: false, errors: [`Send up to ${LIMITS.findings} findings.`] };
  const out: Finding[] = [];
  const errors: string[] = [];
  body.forEach((raw, i) => {
    const f = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const area = plainText(f["area"], LIMITS.area, true), summary = plainText(f["summary"], LIMITS.summary, true);
    const rec = plainText(f["recommendation"], LIMITS.recommendation, false);
    if (!isSeverity(f["severity"]) || !area || !summary || rec === undefined) { errors.push(`Finding ${i + 1} is not complete.`); return; }
    out.push({ severity: f["severity"], area, summary, ...(rec ? { recommendation: rec } : {}) });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
}

/** When the reminder email is due: 24 hours before the start, or null when the start is closer than that (the confirmation covers it). */
export function reminderDueAt(startIso: string, nowIso: string): string | null {
  const due = Date.parse(startIso) - 24 * 60 * 60 * 1000;
  return due > Date.parse(nowIso) ? new Date(due).toISOString() : null;
}

/** True when two bookings overlap. Back-to-back (one ends as the next starts) is allowed. */
export function overlaps(aStart: string, aMinutes: number, bStart: string, bMinutes: number): boolean {
  const a0 = Date.parse(aStart), a1 = a0 + aMinutes * 60_000, b0 = Date.parse(bStart), b1 = b0 + bMinutes * 60_000;
  return a0 < b1 && b0 < a1;
}

export interface FindingsSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  headline: string;
  priorities: Finding[];
  nextSteps: string[];
}

/** A deterministic summary of what was found. It reports; it never says whether to buy, price or negotiate. */
export function summariseFindings(findings: readonly Finding[]): FindingsSummary {
  const bySeverity: Record<Severity, number> = { info: 0, minor: 0, major: 0, urgent: 0 };
  for (const f of findings) bySeverity[f.severity]++;
  const priorities = findings.filter(f => f.severity === "urgent" || f.severity === "major")
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "urgent" ? -1 : 1));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const headline = findings.length === 0
    ? "No findings were recorded."
    : `${plural(findings.length, "finding")}: ${bySeverity.urgent} urgent, ${bySeverity.major} major, ${bySeverity.minor} minor, ${bySeverity.info} for information.`;
  const nextSteps: string[] = [];
  if (bySeverity.urgent > 0) nextSteps.push("Urgent items are safety or serious defects. Ask a licensed tradesperson or your solicitor how to deal with them before anything is signed.");
  if (bySeverity.major > 0) nextSteps.push("Get a quote for each major item and keep the quotes with the inspection report.");
  if (bySeverity.minor > 0) nextSteps.push("Minor items are usually maintenance. List them so both sides know what is already known.");
  if (findings.length > 0) nextSteps.push("Share the report with the other party through the documents page, so it is on record.");
  return { total: findings.length, bySeverity, headline, priorities, nextSteps };
}
