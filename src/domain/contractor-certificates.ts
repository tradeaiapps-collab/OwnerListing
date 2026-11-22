import { daysBetween } from "./contractor-trust";

/**
 * Contractor licence and insurance certificates and the expiry reminders. Pure: no I/O.
 * The badge and Elena's matching already read the expiry dates on the verification details (see verifiedInDateSql), so an expired
 * date takes both away by itself; this module adds the certificate files staff compare against and the reminder schedule.
 */
export const CERT_KINDS = ["insurance", "licence"] as const;
export type CertKind = (typeof CERT_KINDS)[number];
export const CERT_LABEL: Record<CertKind, string> = { insurance: "insurance certificate", licence: "licence" };
export const CERT_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"] as const;
export const MAX_CERT_BYTES = 10_000_000;
export const MAX_CERTS_PER_DAY = 10;

/** Reminder steps. 30 and 7 days before the expiry date, and once it has passed. */
export type Milestone = 30 | 7 | 0;

/** The one reminder that applies today, or null when the expiry is more than 30 days away. The date itself is still in date; "expired" starts the day after. */
export function milestoneFor(expiry: string, today: string): Milestone | null {
  const left = daysBetween(today, expiry);
  if (left < 0) return 0;
  if (left <= 7) return 7;
  if (left <= 30) return 30;
  return null;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Form fields next to the file: kind and the expiry date printed on the certificate (must not be in the past; at most 10 years ahead). */
export function parseCertificateFields(kind: unknown, expiry: unknown, today: string): Parsed<{ kind: CertKind; expiry: string }> {
  if (typeof kind !== "string" || !(CERT_KINDS as readonly string[]).includes(kind)) return { ok: false, message: "Choose insurance or licence." };
  if (typeof expiry !== "string" || !validDate(expiry)) return { ok: false, message: "Enter the expiry date shown on the certificate." };
  if (expiry < today) return { ok: false, message: "That certificate has already expired. Upload the current one." };
  if (daysBetween(today, expiry) > 3660) return { ok: false, message: "That expiry date is too far ahead." };
  return { ok: true, value: { kind: kind as CertKind, expiry } };
}

/** Staff warning when the certificate date and the dates the contractor typed disagree, or when there is no file. */
export function certificateFlags(kind: CertKind, declaredExpiry: string | null, cert: { expiry: string } | undefined): string[] {
  if (declaredExpiry === null) return [];
  if (!cert) return [`No ${CERT_LABEL[kind]} file uploaded.`];
  return cert.expiry === declaredExpiry ? [] : [`The ${CERT_LABEL[kind]} file says it expires ${cert.expiry} but the details say ${declaredExpiry}.`];
}

/** Wording for the reminder email (kind: cert_expiring / cert_expired). */
export function reminderText(kind: CertKind, expiry: string, milestone: Milestone): { title: string; text: string } {
  const what = kind === "insurance" ? "insurance" : "licence";
  if (milestone === 0) {
    return { title: `Your ${what} has expired`, text: `Your ${what} expired on ${expiry}, so your verified badge is off and Elena will not invite you to new jobs. Upload the renewed certificate and send the new details for verification to get them back.` };
  }
  const days = milestone === 7 ? "7 days" : "30 days";
  return { title: `Your ${what} expires within ${days}`, text: `Your ${what} expires on ${expiry}. Upload the renewed certificate and send the new details before then, or your verified badge goes off and Elena stops inviting you to new jobs.` };
}

/** The dates the badge is judged on: the earlier of what the contractor typed and what their current certificate file says. */
export function effectiveDates<V extends { insuranceExpiry: string; licenceExpiry: string | null }>(v: V, certs: Partial<Record<CertKind, string>> | undefined): V {
  if (!certs) return v;
  const earlier = (a: string, b: string | undefined) => (b !== undefined && b < a ? b : a);
  return { ...v, insuranceExpiry: earlier(v.insuranceExpiry, certs.insurance), licenceExpiry: v.licenceExpiry === null ? (certs.licence ?? null) : earlier(v.licenceExpiry, certs.licence) };
}
