import type { StaffActor } from "./staff-access";
import { staffCan } from "./staff-access";
import { lookupEmail } from "./mfa-reset";

/**
 * Account deletion and restoration (owners, agents, buyers and other non-staff accounts). Pure: the routes read the account and write
 * the change. Super admin only: the sensitive permission user.delete and the super_admin role itself, so a custom role given the
 * permission still cannot delete or restore.
 *
 * A deletion is soft. The account is closed at once (signed out everywhere, sign-in refused), its listings are archived, offers still
 * being negotiated are cancelled with a notice to the other side, and accepted offers are left to run to settlement. Nothing is
 * removed: offers, invoices and the audit history are kept for RETENTION_YEARS. Within RECOVERY_DAYS a super admin can restore the
 * account and the user is emailed. After the window the deletion is final; after the retention period the name, email and Google
 * link are cleared and only anonymous records remain.
 */

export const RECOVERY_DAYS = 30;
export const RETENTION_YEARS = 7;
export const DELETE_REASON_MIN = 10;
export const DELETE_REASON_MAX = 300;

/** Offers still being negotiated: cancelled when either side's account is deleted. */
export const PENDING_OFFER_STATUSES = ["submitted", "under_review", "countered", "buyer_countered"] as const;
/** Accepted offers are live contracts in progress (handled by the solicitors): never changed by a deletion. */
export const LIVE_OFFER_STATUSES = ["accepted"] as const;
/** Listing statuses archived with the account. Withdrawn listings are already closed and stay as they are. */
export const ARCHIVABLE_LISTING_STATUSES = ["draft", "pending_review", "published", "suspended"] as const;

const DAY_MS = 86_400_000;

export const addDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

/** Same calendar date N years on (29 Feb lands on 1 Mar in a non-leap year). */
export function addYears(iso: string, years: number): string {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString();
}

export interface DeletionWindows { restoreUntil: string; retainUntil: string }
export const deletionWindows = (now: string): DeletionWindows => ({ restoreUntil: addDays(now, RECOVERY_DAYS), retainUntil: addYears(now, RETENTION_YEARS) });

export const canDeleteAccounts = (staff: StaffActor): boolean => staff.role === "super_admin" && staffCan(staff, "user.delete");

export interface DeletionTarget {
  id: string;
  email: string | null;
  userType: string;
  status: string;
  deletedAt: string | null;
  restoreUntil: string | null;
  deactivatedAt: string | null;
}

export type DeletionPlan = { action: "deny"; status: number; error: string } | { action: "delete"; reason: string; windows: DeletionWindows };
export type RestorePlan = { action: "deny"; status: number; error: string } | { action: "restore"; reason: string };

const deny = (status: number, error: string) => ({ action: "deny" as const, status, error });

function cleanReason(v: unknown): string | null {
  const r = typeof v === "string" ? v.trim() : "";
  return r.length >= DELETE_REASON_MIN && r.length <= DELETE_REASON_MAX ? r : null;
}
const REASON_ERROR = `Give a reason of ${DELETE_REASON_MIN} to ${DELETE_REASON_MAX} characters.`;

export function planAccountDeletion(
  staff: StaffActor, target: DeletionTarget, input: { confirmEmail: unknown; reason: unknown }, now: string
): DeletionPlan {
  if (!canDeleteAccounts(staff)) return deny(403, "Only a super admin can delete accounts.");
  if (target.id === staff.id) return deny(403, "You cannot delete your own account.");
  if (target.userType === "admin") return deny(403, "Staff accounts are removed in Staff access, not here.");
  if (target.deletedAt !== null) return deny(409, "This account is already deleted.");
  if (target.status === "closed") return deny(409, "This account is already closed.");
  if (!target.email || lookupEmail(input.confirmEmail) !== target.email.toLowerCase()) return deny(400, "Type the account's email exactly to confirm the deletion.");
  const reason = cleanReason(input.reason);
  if (!reason) return deny(400, REASON_ERROR);
  return { action: "delete", reason, windows: deletionWindows(now) };
}

export function planAccountRestore(staff: StaffActor, target: DeletionTarget, input: { reason: unknown }, now: string): RestorePlan {
  if (!canDeleteAccounts(staff)) return deny(403, "Only a super admin can restore accounts.");
  if (target.deletedAt === null) return deny(409, "This account is not deleted.");
  if (target.deactivatedAt !== null || target.restoreUntil === null || Date.parse(target.restoreUntil) <= Date.parse(now)) {
    return deny(409, `The ${RECOVERY_DAYS}-day recovery window for this account has closed, so it can no longer be restored.`);
  }
  const reason = cleanReason(input.reason);
  if (!reason) return deny(400, REASON_ERROR);
  return { action: "restore", reason };
}

/** Where a deleted account stands. */
export type RetentionStage = "restorable" | "final" | "purge_due" | "purged";

export interface RetentionFacts { restoreUntil: string; retainUntil: string; deactivatedAt: string | null; purgedAt: string | null }

export function retentionStage(f: RetentionFacts, now: string): RetentionStage {
  if (f.purgedAt !== null) return "purged";
  const t = Date.parse(now);
  if (Date.parse(f.retainUntil) <= t) return "purge_due";
  if (f.deactivatedAt === null && Date.parse(f.restoreUntil) > t) return "restorable";
  return "final";
}

/** Whole days left until `until` (0 once passed). */
export const daysLeft = (until: string, now: string): number => Math.max(0, Math.ceil((Date.parse(until) - Date.parse(now)) / DAY_MS));

// ---- Notices ----

const dateAu = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Brisbane" });

/** To the account holder when the account is deleted. No link: they contact support, who check who they are before restoring. */
export function accountDeletedEmail(brandName: string, restoreUntil: string): { subject: string; text: string } {
  return {
    subject: `Your ${brandName} account has been deleted`,
    text: [
      "Hello,",
      "",
      `Your ${brandName} account has been deleted by our team and you have been signed out. Your listings have been taken off the site, and offers that were still being negotiated have been cancelled. Accepted offers are not affected and continue with the solicitors as agreed.`,
      "",
      `If you want your account back, contact ${brandName} support before ${dateAu(restoreUntil)}. Until then we can restore it with your listings.`,
      "",
      `We keep records of offers and payments for ${RETENTION_YEARS} years, as the law requires, and then remove your name and email from them.`
    ].join("\n")
  };
}

/** To the account holder when the account is restored. */
export function accountRestoredEmail(brandName: string, appUrl: string): { subject: string; text: string } {
  const site = appUrl ? ` at ${appUrl}` : "";
  return {
    subject: `Your ${brandName} account has been restored`,
    text: [
      "Hello,",
      "",
      `Your ${brandName} account has been restored. You can sign in${site} with your Google account as usual.`,
      "",
      "Listings that were live before need to pass the publish checks again; any that do not are kept for you to review. Offers cancelled when the account was deleted stay cancelled.",
      "",
      `If you did not ask for this, contact ${brandName} support straight away.`
    ].join("\n")
  };
}

/** To the other side of a cancelled offer. Says only that the other account closed, never why. */
export function offerCancelledEmail(brandName: string, recipient: "buyer" | "owner", title: string): { subject: string; text: string } {
  const listingTitle = title.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 120);
  const what = recipient === "buyer"
    ? `the owner of "${listingTitle}" has closed their ${brandName} account, so the listing is no longer available and your offer has been cancelled.`
    : `the buyer who made an offer on "${listingTitle}" has closed their ${brandName} account, so their offer has been cancelled. Your listing is not affected.`;
  return {
    subject: `An offer on "${listingTitle}" has been cancelled`,
    text: ["Hello,", "", `We are letting you know that ${what}`, "", "No action is needed from you."].join("\n")
  };
}
