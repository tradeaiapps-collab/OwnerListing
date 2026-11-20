import { validateAbn } from "./abn";
import { findProfanity } from "./profanity-filter";

/** Pure rules for contractor trust and safety. Nothing here calls an outside registry: staff check what the contractor supplied. */

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };
const bad = (message: string): { ok: false; message: string } => ({ ok: false, message });
const DAY_MS = 86_400_000;
export const EXPIRY_WARNING_DAYS = 30;

const str = (v: unknown, min: number, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : undefined;
};

/** A calendar date as YYYY-MM-DD, or undefined. */
export function parseDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// ---------- Verification ----------
export interface VerificationInput {
  businessName: string; abn: string;
  licenceNumber: string | null; licenceAuthority: string | null; licenceExpiry: string | null;
  insurer: string; policyNumber: string; insuranceExpiry: string;
}

/** `today` is YYYY-MM-DD. Insurance must be current; a licence is optional but, if given, needs its issuer and a current expiry. */
export function parseVerification(input: unknown, today: string): Parsed<VerificationInput> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const businessName = str(o["businessName"], 1, 120);
  if (!businessName) return bad("Enter your business or trading name (up to 120 characters).");
  const abn = validateAbn(o["abn"]);
  if (!abn.ok) return bad(abn.error);
  const insurer = str(o["insurer"], 1, 120), policyNumber = str(o["policyNumber"], 1, 60);
  if (!insurer || !policyNumber) return bad("Enter the insurer and the policy number.");
  const insuranceExpiry = parseDate(o["insuranceExpiry"]);
  if (!insuranceExpiry) return bad("Enter the insurance expiry date as YYYY-MM-DD.");
  if (insuranceExpiry < today) return bad("This insurance has already expired. Renew it first.");
  const number = o["licenceNumber"] === undefined || o["licenceNumber"] === "" || o["licenceNumber"] === null ? null : str(o["licenceNumber"], 1, 60);
  const authority = o["licenceAuthority"] === undefined || o["licenceAuthority"] === "" || o["licenceAuthority"] === null ? null : str(o["licenceAuthority"], 1, 120);
  const rawExpiry = o["licenceExpiry"] === undefined || o["licenceExpiry"] === "" || o["licenceExpiry"] === null ? null : parseDate(o["licenceExpiry"]);
  if ((number === undefined) || (authority === undefined) || (rawExpiry === undefined)) return bad("Check the licence number, issuing authority and expiry date (YYYY-MM-DD).");
  if ((number === null) !== (authority === null)) return bad("Give both the licence number and who issued it, or leave both empty.");
  if (number !== null && rawExpiry === null) return bad("Enter the licence expiry date.");
  if (rawExpiry !== null && number === null) return bad("Enter the licence number with its expiry date.");
  if (rawExpiry !== null && rawExpiry < today) return bad("This licence has already expired. Renew it first.");
  if (findProfanity([businessName, insurer].join(" ")).length > 0) return bad("Please remove inappropriate language.");
  return { ok: true, value: { businessName, abn: abn.abn, licenceNumber: number, licenceAuthority: authority, licenceExpiry: rawExpiry, insurer, policyNumber, insuranceExpiry } };
}

export type VerificationStatus = "none" | "pending" | "verified" | "rejected";
export interface VerificationState {
  status: VerificationStatus;
  /** The public badge: staff verified AND insurance (and licence, if given) still in date today. */
  badge: boolean;
  insuranceExpired: boolean; licenceExpired: boolean;
  insuranceExpiringInDays: number | null; licenceExpiringInDays: number | null;
  warnings: string[];
}

export function verificationState(row: { status: string; insuranceExpiry: string; licenceExpiry: string | null } | undefined, today: string): VerificationState {
  if (!row) return { status: "none", badge: false, insuranceExpired: false, licenceExpired: false, insuranceExpiringInDays: null, licenceExpiringInDays: null, warnings: [] };
  const status = row.status === "verified" || row.status === "rejected" ? row.status : "pending";
  const insDays = daysBetween(today, row.insuranceExpiry);
  const licDays = row.licenceExpiry ? daysBetween(today, row.licenceExpiry) : null;
  const insuranceExpired = insDays < 0, licenceExpired = licDays !== null && licDays < 0;
  const warnings: string[] = [];
  if (insuranceExpired) warnings.push("Your insurance has expired, so your verified badge is off. Submit your new certificate details to get it back.");
  else if (insDays <= EXPIRY_WARNING_DAYS) warnings.push(`Your insurance expires in ${insDays} day${insDays === 1 ? "" : "s"}. Submit the renewal before then to keep your verified badge.`);
  if (licenceExpired) warnings.push("Your licence has expired, so your verified badge is off. Submit the renewed licence details.");
  else if (licDays !== null && licDays <= EXPIRY_WARNING_DAYS) warnings.push(`Your licence expires in ${licDays} day${licDays === 1 ? "" : "s"}. Submit the renewal before then to keep your verified badge.`);
  return {
    status, badge: status === "verified" && !insuranceExpired && !licenceExpired,
    insuranceExpired, licenceExpired, insuranceExpiringInDays: insuranceExpired ? null : insDays, licenceExpiringInDays: licDays === null || licenceExpired ? null : licDays, warnings
  };
}

export const todayUtc = (now: Date = new Date()) => now.toISOString().slice(0, 10);

// ---------- Complaints ----------
// Owners file them through contractor operations (POST /api/assignments/[id]/complaint); staff decide them here.
export type StaffReportAction = "dismiss" | "uphold" | "uphold_and_suspend";
export function parseReportDecision(input: unknown): Parsed<{ action: StaffReportAction; note: string }> {
  if (typeof input !== "object" || input === null) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const a = o["action"];
  if (a !== "dismiss" && a !== "uphold" && a !== "uphold_and_suspend") return bad("Action must be dismiss, uphold or uphold_and_suspend.");
  const note = str(o["note"], 1, 500);
  if (!note) return bad("Add a note (up to 500 characters) explaining the decision.");
  return { ok: true, value: { action: a, note } };
}

export function parseSuspension(input: unknown): Parsed<{ action: "suspend" | "reinstate"; note: string }> {
  if (typeof input !== "object" || input === null) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  if (o["action"] !== "suspend" && o["action"] !== "reinstate") return bad("Action must be suspend or reinstate.");
  const note = str(o["note"], 1, 500);
  if (!note) return bad("Add a reason (up to 500 characters).");
  return { ok: true, value: { action: o["action"], note } };
}

export function parseVerificationDecision(input: unknown): Parsed<{ action: "verify" | "reject"; note: string | null }> {
  if (typeof input !== "object" || input === null) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  if (o["action"] !== "verify" && o["action"] !== "reject") return bad("Action must be verify or reject.");
  const note = o["note"] === undefined ? null : str(o["note"], 1, 500) ?? undefined;
  if (note === undefined) return bad("Note must be 1 to 500 characters.");
  if (o["action"] === "reject" && !note) return bad("Say why the details were rejected so the contractor can fix them.");
  return { ok: true, value: { action: o["action"], note } };
}

// ---------- Quotes ----------
export const MAX_QUOTE_CENTS = 100_000_000;
export function parseQuote(input: unknown): Parsed<{ amountCents: number; description: string }> {
  if (typeof input !== "object" || input === null) return bad("Send a JSON object.");
  const o = input as Record<string, unknown>;
  const cents = o["amountCents"];
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0 || cents > MAX_QUOTE_CENTS) return bad("Enter the quote as an amount between $0.01 and $1,000,000.");
  const description = str(o["description"], 10, 2000);
  if (!description) return bad("Describe the work and what the price includes (10 to 2000 characters).");
  return { ok: true, value: { amountCents: cents, description } };
}
export const parseQuoteDecision = (input: unknown): Parsed<"accept" | "decline" | "withdraw"> => {
  const a = typeof input === "object" && input !== null ? (input as Record<string, unknown>)["action"] : undefined;
  return a === "accept" || a === "decline" || a === "withdraw" ? { ok: true, value: a } : bad("Action must be accept, decline or withdraw.");
};

// ---------- Reviews ----------
export function parseReply(input: unknown): Parsed<string> {
  const reply = typeof input === "object" && input !== null ? str((input as Record<string, unknown>)["reply"], 1, 1000) : undefined;
  return reply ? { ok: true, value: reply } : bad("A reply must be 1 to 1000 characters.");
}

// ---------- Privacy ----------
export const USAGE_RIGHTS_VERSION = 1;
export const USAGE_RIGHTS_TEXT =
  "I confirm I own the copyright in the photos and video I upload for this job, or have the right to licence them, and I give the property owner a licence to use them to market this property, including on listing sites and printed material.";

/** What a contractor may see of a property before accepting a job: the area only, never the street. */
export function areaOnly(a: { suburb: string | null; postcode: string | null; jurisdiction: string }): string {
  const parts = [a.suburb?.trim(), a.jurisdiction.trim(), a.postcode?.trim()].filter((p): p is string => !!p);
  return parts.length > 1 ? parts.join(" ") : `${a.jurisdiction.trim()} (street address shared once you accept)`;
}

/** The full address is for the owner, and for the contractor only once they have accepted (approved) or finished the job. */
export function canSeeFullAddress(role: "owner" | "contractor", status: string): boolean {
  return role === "owner" || status === "approved" || status === "completed";
}

/** Stars as one decimal, and the count. */
export function summariseRatings(ratings: readonly number[]): { average: number | null; count: number } {
  if (ratings.length === 0) return { average: null, count: 0 };
  return { average: Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10, count: ratings.length };
}

/**
 * A job as a contractor may see it: the street address is replaced by the suburb until they have accepted, and again once the job is
 * cancelled. The owner always sees the full address. Apply to every job a contractor can read or be notified about.
 */
export function maskJobAddress<T extends { address: string; suburb?: string; status: string; contractorUserId: string }>(job: T, viewerId: string): T {
  if (viewerId !== job.contractorUserId || canSeeFullAddress("contractor", job.status)) return job;
  return { ...job, address: job.suburb ? `${job.suburb} (street address shown once you accept)` : "Street address shown once you accept" };
}
