import { reasonOk, REASON_ERROR, type Deny } from "./staff-admin";
import { staffCan, type StaffActor } from "./staff-access";

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

export interface QueueTarget { id: string; status: string; subjectOwnerId: string | null }
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
