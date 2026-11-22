import { reasonOk, REASON_ERROR, type Deny } from "./staff-admin";
import { staffCan, type StaffActor } from "./staff-access";
import { planListingAction, planUserAction } from "./admin-moderation";

/**
 * The staff review queue: one place for listings, messages and profiles that a filter or a report flagged.
 * Staff approve (content is fine), reject (content breaks the rules) or escalate (needs a senior decision).
 * Every decision needs a reason. Nobody decides on their own content. Only senior reviewers resolve an escalated item.
 */
export const SUBJECT_TYPES = ["listing", "message", "profile"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export const isSubjectType = (v: unknown): v is SubjectType => typeof v === "string" && (SUBJECT_TYPES as readonly string[]).includes(v);

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ITEM_STATUSES = ["open", "escalated", "approved", "rejected"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const isItemStatus = (v: unknown): v is ItemStatus => typeof v === "string" && (ITEM_STATUSES as readonly string[]).includes(v);

export const DECISIONS = ["approve", "reject", "escalate"] as const;
export type Decision = (typeof DECISIONS)[number];
export const isDecision = (v: unknown): v is Decision => typeof v === "string" && (DECISIONS as readonly string[]).includes(v);

export const NEXT_STATUS: Record<Decision, ItemStatus> = { approve: "approved", reject: "rejected", escalate: "escalated" };

export interface QueueTarget { id: string; status: string; subjectOwnerId: string | null; subjectType?: SubjectType; subjectId?: string }
export type DecisionPlan = Deny | { action: "plan"; decision: Decision; from: "open" | "escalated"; to: ItemStatus; note: string };

const deny = (status: number, error: string): Deny => ({ action: "deny", status, error });

/** Decisions this staff member may take on an item in this status (the screen shows these; the route re-checks with planDecision). */
export function decisionsFor(actor: StaffActor, status: string): Decision[] {
  if (!staffCan(actor, "moderation.review")) return [];
  if (status === "open") return ["approve", "reject", "escalate"];
  if (status === "escalated" && staffCan(actor, "moderation.resolve_escalated")) return ["approve", "reject"];
  return [];
}

export function planDecision(actor: StaffActor, item: QueueTarget, decision: unknown, note: unknown): DecisionPlan {
  if (!staffCan(actor, "moderation.review")) return deny(403, "Not allowed.");
  if (!isDecision(decision)) return deny(400, "Decision must be approve, reject or escalate.");
  if (!reasonOk(note)) return deny(400, REASON_ERROR);
  if (item.status !== "open" && item.status !== "escalated") return deny(409, "Already decided.");
  if (item.subjectOwnerId && item.subjectOwnerId === actor.id) return deny(403, "You cannot review your own content.");
  if (item.status === "escalated") {
    if (decision === "escalate") return deny(409, "Already escalated.");
    if (!staffCan(actor, "moderation.resolve_escalated")) return deny(403, "Only a senior reviewer can decide an escalated item.");
  }
  return { action: "plan", decision, from: item.status, to: NEXT_STATUS[decision], note: note.trim() };
}

/** Where staff can look at the subject itself. Rejecting does not change the content by itself: staff then use the listing or user screens. */
export const subjectLink = (type: SubjectType, id: string): string | null => (type === "listing" ? `/listings/${id}` : null);

/**
 * Rejecting an item can also suspend what it is about, but only when staff say so and confirm it. Body fields:
 * suspend: "none" (default) | "listing" (the item's listing) | "account" (the account that wrote or owns the content),
 * confirm: must be true for any suspension, listings: "suspend" (default) | "keep" for an account (what happens to its live listings).
 * Each suspension re-uses the rules of the listing and user screens (permission, own-account block, staff accounts, status checks) and
 * needs the same reason, which is also written to the audit log.
 */
export const SUSPEND_CHOICES = ["none", "listing", "account"] as const;
export type SuspendChoice = (typeof SUSPEND_CHOICES)[number];

export type SuspensionPlan =
  | Deny
  | { kind: "none" }
  | { kind: "listing"; listingId: string; from: "published"; reason: string }
  | { kind: "account"; userId: string; from: string; reason: string; withListings: boolean };

/** What the suspension would act on, read fresh by the route. */
export interface SuspensionFacts { listingStatus?: string | undefined; user?: { id: string; userType: string; status: string } | undefined }

export function planSuspension(actor: StaffActor, item: QueueTarget, decision: Decision, body: Record<string, unknown> | null, facts: SuspensionFacts): SuspensionPlan {
  const choice = body?.["suspend"] ?? "none";
  if (!SUSPEND_CHOICES.includes(choice as SuspendChoice)) return deny(400, 'Suspend must be "none", "listing" or "account".');
  if (choice === "none") return { kind: "none" };
  if (decision !== "reject") return deny(400, "Only rejecting an item can suspend anything.");
  if (body?.["confirm"] !== true) return deny(400, "Confirm the suspension before it is applied.");
  const reason = body?.["reason"];
  if (choice === "listing") {
    if (item.subjectType !== "listing" || !item.subjectId || facts.listingStatus === undefined) return deny(400, "This item is not about a listing.");
    const p = planListingAction(actor, facts.listingStatus, "suspend", reason);
    return p.action === "deny" ? p : { kind: "listing", listingId: item.subjectId, from: "published", reason: p.reason };
  }
  if (!item.subjectOwnerId || !facts.user) return deny(400, "This item has no account to suspend.");
  const p = planUserAction(actor, facts.user, "suspend", reason, body?.["listings"]);
  return p.action === "deny" ? p : { kind: "account", userId: facts.user.id, from: p.from, reason: p.reason, withListings: p.withListings };
}

/**
 * Undoing a suspension that a rejection made from this queue. Only a rejected item that suspended something, and only once. Same rules as the
 * listing and user screens (permissions, own-account block, reason), plus the queue's own rule that nobody reviews their own content.
 * A listing goes live again only through the publish gate, which the route runs. Body: reason, and for an account listings: "reinstate" | "keep".
 */
export interface QueueSuspension { kind: "listing" | "account"; listingId?: string; userId?: string }
export type ReinstatePlan =
  | Deny
  | { kind: "listing"; listingId: string; reason: string }
  | { kind: "account"; userId: string; from: string; reason: string; withListings: boolean };

export function planReinstate(
  actor: StaffActor, item: QueueTarget, suspension: QueueSuspension | null, alreadyReinstated: boolean, body: Record<string, unknown> | null, facts: SuspensionFacts
): ReinstatePlan {
  if (!staffCan(actor, "moderation.review")) return deny(403, "Not allowed.");
  if (item.status !== "rejected") return deny(409, "Only a rejected item can be reinstated.");
  if (!suspension) return deny(409, "This rejection did not suspend anything.");
  if (alreadyReinstated) return deny(409, "Already reinstated.");
  if (item.subjectOwnerId && item.subjectOwnerId === actor.id) return deny(403, "You cannot review your own content.");
  const reason = body?.["reason"];
  if (suspension.kind === "listing") {
    if (!suspension.listingId || facts.listingStatus === undefined) return deny(409, "The listing is no longer available.");
    const p = planListingAction(actor, facts.listingStatus, "reinstate", reason);
    return p.action === "deny" ? p : { kind: "listing", listingId: suspension.listingId, reason: p.reason };
  }
  if (!suspension.userId || !facts.user) return deny(409, "The account is no longer available.");
  const p = planUserAction(actor, facts.user, "reinstate", reason, body?.["listings"]);
  return p.action === "deny" ? p : { kind: "account", userId: facts.user.id, from: p.from, reason: p.reason, withListings: p.withListings };
}
