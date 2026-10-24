import { evaluateOverride, staffCan, type OverrideTarget, type StaffActor, type StaffPermission } from "./staff-access";

export const MIN_REASON = 10;
export const reasonOk = (r: unknown): r is string => typeof r === "string" && r.trim().length >= MIN_REASON;
export const REASON_ERROR = `A reason of at least ${MIN_REASON} characters is required.`;

export interface StaffSection { href: string; label: string; permission: StaffPermission }

const SECTIONS: readonly StaffSection[] = [
  { href: "/staff/cases", label: "Admin cases", permission: "case.manage" },
  { href: "/staff/trust-accounts", label: "Trust account approvals", permission: "trust_account.approve" },
  { href: "/staff/id-review", label: "Identity review", permission: "identity.review" },
  { href: "/staff/reports", label: "Reports", permission: "report.sales" },
  { href: "/staff/audit", label: "Audit log", permission: "report.audit" },
  { href: "/staff/invites", label: "Staff access", permission: "staff.manage" },
  { href: "/staff/messaging", label: "Messaging settings", permission: "staff.manage" }
];

/** Only the sections this staff member's role allows. */
export const sectionsFor = (actor: StaffActor): StaffSection[] => SECTIONS.filter(s => staffCan(actor, s.permission));

export type CaseKind = "trust_account_verification" | "licence_verification" | "identity_verification" | "other";
export interface CaseState {
  kind: CaseKind; status: "open" | "in_progress" | "resolved"; assignedTo: string | null;
  proposedBy: string | null; proposedByRole: StaffActor["role"] | null; proposedReason: string | null;
}
export type Deny = { action: "deny"; status: number; error: string };
export type ResolvePlan =
  | Deny
  | { action: "resolve"; override: { actorId: string; approverId: string; reason: string; target: OverrideTarget } | null; reason: string }
  | { action: "propose"; reason: string };

const deny = (status: number, error: string): Deny => ({ action: "deny", status, error });
const GATE_TARGET: Partial<Record<CaseKind, OverrideTarget>> = { trust_account_verification: "trust_account", licence_verification: "licence" };

export function planClaim(actor: StaffActor, c: Pick<CaseState, "status" | "assignedTo">): Deny | { action: "claim" } {
  if (!staffCan(actor, "case.manage")) return deny(403, "Not allowed.");
  if (c.status === "resolved") return deny(409, "This case is already resolved.");
  if (c.assignedTo !== null && c.assignedTo !== actor.id) return deny(409, "This case is already claimed.");
  return { action: "claim" };
}

/**
 * Closing a case needs a reason. Safety-gate cases (trust account, licence) are overrides: the first person proposes,
 * a different authorised person confirms (evaluateOverride), and the pair is logged in override_log.
 * Identity cases are closed only through the identity review queue.
 */
export function planCaseResolve(actor: StaffActor, c: CaseState, reason: unknown): ResolvePlan {
  if (!staffCan(actor, "case.manage")) return deny(403, "Not allowed.");
  if (!reasonOk(reason)) return deny(400, REASON_ERROR);
  if (c.status === "resolved") return deny(409, "This case is already resolved.");
  if (c.kind === "identity_verification") return deny(409, "Identity cases are closed through the identity review queue.");
  const target = GATE_TARGET[c.kind];
  if (!target) {
    return c.assignedTo === actor.id ? { action: "resolve", override: null, reason } : deny(403, "Claim the case before resolving it.");
  }
  if (c.proposedBy === null) {
    if (c.assignedTo !== actor.id) return deny(403, "Claim the case before resolving it.");
    const d = evaluateOverride(actor, { target, reason });
    if (d.allowed) return deny(500, "Safety gates always need a second person.");
    return d.requiresSecondApprover ? { action: "propose", reason } : deny(403, d.reasons[0] ?? "Not allowed.");
  }
  if (c.proposedByRole === null || c.proposedReason === null) return deny(409, "The proposing staff member is no longer active.");
  const d = evaluateOverride({ id: c.proposedBy, role: c.proposedByRole }, { target, reason: c.proposedReason }, actor);
  if (!d.allowed) return deny(403, d.reasons[0] ?? "A different authorised person must approve this override.");
  return { action: "resolve", override: { actorId: c.proposedBy, approverId: actor.id, reason: c.proposedReason, target }, reason };
}

export interface TrustCheckState {
  decision: string; latest: boolean; fingerprint: string; lastApprovedFingerprint: string | null;
  priors: readonly { staffId: string; outcome: "approve" | "reject" }[];
}
export type TrustPlan = Deny | { action: "reject" } | { action: "first_approval" } | { action: "approve" };

/** New accounts and changed details need two different people to approve; one reject is final. */
export function planTrustDecision(actor: StaffActor, c: TrustCheckState, outcome: unknown, reason: unknown): TrustPlan {
  if (!staffCan(actor, "trust_account.approve")) return deny(403, "Not allowed.");
  if (outcome !== "approve" && outcome !== "reject") return deny(400, "Outcome must be approve or reject.");
  if (!reasonOk(reason)) return deny(400, REASON_ERROR);
  if (c.decision !== "awaiting_human_approval" || !c.latest) return deny(409, "This check is not waiting for approval.");
  if (c.priors.some(p => p.outcome === "reject")) return deny(409, "This check was rejected.");
  if (c.priors.some(p => p.staffId === actor.id)) return deny(403, "You have already decided on this check; a different person must act.");
  if (outcome === "reject") return { action: "reject" };
  const needsSecond = c.lastApprovedFingerprint === null || c.lastApprovedFingerprint !== c.fingerprint;
  return needsSecond && c.priors.length === 0 ? { action: "first_approval" } : { action: "approve" };
}
