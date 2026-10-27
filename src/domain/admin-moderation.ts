import { reasonOk, REASON_ERROR, type Deny } from "./staff-admin";
import { staffCan, type StaffActor } from "./staff-access";
import type { ListingStatus } from "./listing";

/**
 * Staff moderation of listings and user accounts. Every action needs a reason and is audited in the same transaction as the change.
 * Staff never publish a listing past the publish gate: "reinstate" re-runs it, and there is no "approve" that skips it.
 */

export const LISTING_ACTIONS = ["suspend", "reinstate", "send_back"] as const;
export type ListingAction = (typeof LISTING_ACTIONS)[number];
export const isListingAction = (v: unknown): v is ListingAction => typeof v === "string" && (LISTING_ACTIONS as readonly string[]).includes(v);

const LISTING_MOVES: Record<ListingAction, { from: ListingStatus; to: ListingStatus; label: string }> = {
  suspend: { from: "published", to: "suspended", label: "Suspend" },
  reinstate: { from: "suspended", to: "published", label: "Reinstate" },
  send_back: { from: "pending_review", to: "draft", label: "Send back to draft" }
};

/** Actions offered for a listing in this status (the screen shows these; the route re-checks with planListingAction). */
export const listingActionsFor = (status: string): { action: ListingAction; label: string }[] =>
  LISTING_ACTIONS.filter(a => LISTING_MOVES[a].from === status).map(a => ({ action: a, label: LISTING_MOVES[a].label }));

const deny = (status: number, error: string): Deny => ({ action: "deny", status, error });

export type ListingPlan = Deny | { action: ListingAction; from: ListingStatus; to: ListingStatus; reason: string; needsPublishGate: boolean };

export function planListingAction(actor: StaffActor, current: string, action: unknown, reason: unknown): ListingPlan {
  if (!staffCan(actor, "listing.moderate")) return deny(403, "Not allowed.");
  if (!isListingAction(action)) return deny(400, "Unknown action.");
  if (!reasonOk(reason)) return deny(400, REASON_ERROR);
  const move = LISTING_MOVES[action];
  if (current !== move.from) return deny(409, `Only a listing that is ${move.from.replace("_", " ")} can be changed this way.`);
  return { action, from: move.from, to: move.to, reason: reason.trim(), needsPublishGate: move.to === "published" };
}

export const USER_ACTIONS = ["suspend", "reinstate"] as const;
export type UserAction = (typeof USER_ACTIONS)[number];
export const isUserAction = (v: unknown): v is UserAction => typeof v === "string" && (USER_ACTIONS as readonly string[]).includes(v);

export interface UserTarget { id: string; userType: string; status: string }
export type UserPlan = Deny | { action: UserAction; from: string; to: "suspended" | "active"; reason: string; withListings: boolean };

/**
 * What happens to the account's listings, chosen per case. Suspending: "suspend" (default) also suspends every live listing, "keep"
 * leaves them live. Reinstating: "reinstate" (default) brings back the listings suspended with the account, each only if it passes the
 * publish checks today; "keep" leaves them suspended.
 */
export const LISTING_CHOICES: Record<UserAction, readonly [string, string]> = { suspend: ["suspend", "keep"], reinstate: ["reinstate", "keep"] };

/**
 * Suspend an active account or reinstate a suspended one. A suspended account is refused on its very next request (sessions are checked
 * against the database). Staff accounts are managed only through staff access (invites), and nobody acts on their own account.
 * Pending and closed accounts are left alone: a pending account has not finished sign-up and closing is permanent.
 */
export function planUserAction(actor: StaffActor, target: UserTarget, action: unknown, reason: unknown, listings?: unknown): UserPlan {
  if (!staffCan(actor, "user.manage")) return deny(403, "Not allowed.");
  if (!isUserAction(action)) return deny(400, "Unknown action.");
  if (!reasonOk(reason)) return deny(400, REASON_ERROR);
  if (target.id === actor.id) return deny(403, "You cannot change your own account.");
  if (target.userType === "admin") return deny(409, "Staff accounts are managed in Staff access.");
  if (action === "suspend" && target.status !== "active") return deny(409, "Only an active account can be suspended.");
  if (action === "reinstate" && target.status !== "suspended") return deny(409, "Only a suspended account can be reinstated.");
  const [change, keep] = LISTING_CHOICES[action];
  const choice = listings ?? change;
  if (choice !== change && choice !== keep) return deny(400, `Listings must be "${change}" or "${keep}".`);
  const withListings = choice === change;
  if (withListings && !staffCan(actor, "listing.moderate")) {
    return deny(403, "Changing this account's listings also needs the listing moderation permission. Choose to keep them as they are.");
  }
  return { action, from: target.status, to: action === "suspend" ? "suspended" : "active", reason: reason.trim(), withListings };
}

/** "jane.citizen@gmail.com" -> "j***n@gmail.com"; anything without an @ is fully hidden. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  return `${local[0]}***${local.length > 2 ? local[local.length - 1] : ""}${email.slice(at)}`;
}

/** Personal details as the role may see them: full with pii.view_full, otherwise masked (user.manage alone never shows full details). */
export function showPersonal(actor: StaffActor, v: { name: string; email: string | null }): { name: string; email: string | null } {
  if (staffCan(actor, "pii.view_full")) return v;
  const parts = v.name.trim().split(/\s+/).filter(Boolean);
  const name = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : parts[0] ? `${parts[0][0]}.` : "";
  return { name, email: v.email ? maskEmail(v.email) : null };
}

/** Compliance flags shown for an account. Each is a plain fact from stored records, never a score. */
export interface ComplianceFacts {
  emailVerified: boolean; phoneVerified: boolean; idVerified: boolean; idPending: boolean;
  licence: "not_needed" | "verified" | "expired" | "missing"; termsCurrent: boolean; openCases: number;
}

/** Short notes for what still needs attention, in plain words. An empty list means nothing outstanding. */
export function complianceNotes(userType: string, f: ComplianceFacts): string[] {
  const out: string[] = [];
  if (userType === "buyer") {
    if (!f.emailVerified) out.push("Email not verified");
    if (!f.phoneVerified) out.push("Phone not verified");
    if (!f.idVerified) out.push(f.idPending ? "ID check waiting for review" : "ID not verified");
  }
  if (userType === "agent" && f.licence !== "verified") out.push(f.licence === "expired" ? "Agent licence expired" : "No verified agent licence");
  if (!f.termsCurrent) out.push("Current terms not accepted");
  if (f.openCases > 0) out.push(`${f.openCases} open admin case${f.openCases === 1 ? "" : "s"}`);
  return out;
}
