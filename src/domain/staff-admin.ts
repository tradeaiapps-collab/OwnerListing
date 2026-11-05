import { evaluateOverride, staffCan, type OverrideTarget, type StaffActor, type StaffPermission } from "./staff-access";

export const MIN_REASON = 10;
export const reasonOk = (r: unknown): r is string => typeof r === "string" && r.trim().length >= MIN_REASON;
export const REASON_ERROR = `A reason of at least ${MIN_REASON} characters is required.`;

/** A staff screen and the permissions that open it (any one of them). The API routes behind each screen use the same permissions. */
export interface StaffSection { href: string; label: string; permissions: readonly StaffPermission[] }

export const STAFF_SECTIONS: readonly StaffSection[] = [
  { href: "/staff/dashboard", label: "Admin dashboard", permissions: ["report.sales", "report.operations", "listing.moderate", "user.manage"] },
  { href: "/staff/settlements", label: "Settlements", permissions: ["report.sales", "report.operations"] },
  { href: "/staff/sale-events", label: "Sold and rented events", permissions: ["sale_event.manage", "report.sales"] },
  { href: "/staff/listings", label: "Listing moderation", permissions: ["listing.moderate"] },
  { href: "/staff/users", label: "User accounts", permissions: ["user.manage"] },
  { href: "/staff/inspections", label: "Inspections", permissions: ["user.manage"] },
  { href: "/staff/users/deleted-accounts", label: "Deleted accounts", permissions: ["user.delete"] },
  { href: "/staff/cases", label: "Admin cases", permissions: ["case.manage"] },
  { href: "/staff/safety", label: "Message safety review", permissions: ["case.manage"] },
  { href: "/staff/moderation", label: "Message moderation", permissions: ["case.manage"] },
  { href: "/staff/trust-accounts", label: "Trust account approvals", permissions: ["trust_account.approve"] },
  { href: "/staff/escrow", label: "Deposits in trust", permissions: ["escrow.manage", "escrow.approve"] },
  { href: "/staff/id-review", label: "Identity review", permissions: ["identity.review"] },
  { href: "/staff/scheduling-templates", label: "Elena scheduling messages", permissions: ["scheduling_template.manage"] },
  { href: "/staff/prequalifications", label: "Buyer pre-approvals", permissions: ["prequal.review"] },
  { href: "/staff/public-holidays", label: "Public holidays", permissions: ["holiday.manage"] },
  { href: "/staff/wording-flags", label: "Discriminatory wording review", permissions: ["wording.review"] },
  { href: "/staff/disclosures", label: "Disclosure requirements", permissions: ["disclosure.config_edit", "disclosure.config_approve"] },
  { href: "/staff/doc-templates", label: "Document templates", permissions: ["doc_template.edit", "doc_template.publish"] },
  { href: "/staff/disclosures/reviews", label: "Disclosure evidence review", permissions: ["disclosure.verify"] },
  { href: "/staff/analytics", label: "Analytics", permissions: ["report.sales"] },
  { href: "/staff/elena-insights", label: "Elena insights", permissions: ["report.sales"] },
  { href: "/staff/feasibility", label: "Project feasibility", permissions: ["report.operations", "report.sales"] },
  { href: "/staff/alerts", label: "Alert thresholds", permissions: ["report.sales"] },
  { href: "/staff/report-builder", label: "Report builder", permissions: ["report.sales"] },
  { href: "/staff/reports", label: "Reports", permissions: ["report.sales"] },
  { href: "/staff/audit", label: "Audit log", permissions: ["report.audit"] },
  { href: "/staff/finance", label: "Finance", permissions: ["report.financial"] },
  { href: "/staff/pricing", label: "Pricing and plans", permissions: ["pricing.manage"] },
  { href: "/staff/invites", label: "Staff access", permissions: ["staff.manage"] },
  { href: "/staff/roles", label: "Roles and permissions", permissions: ["staff.manage"] },
  { href: "/staff/security/mfa-reset", label: "Two-step sign-in reset", permissions: ["user.mfa_reset"] },
  { href: "/staff/messaging", label: "Messaging settings", permissions: ["messaging.settings"] },
  { href: "/staff/listing-syndication", label: "Listing portals", permissions: ["syndication.manage"] },
  { href: "/staff/site", label: "Site appearance", permissions: ["theme.edit"] },
  { href: "/staff/white-label", label: "Agency brands", permissions: ["theme.edit"] },
  { href: "/staff/assistant", label: "Guide assistant", permissions: ["site.content.edit", "site.content.publish"] },
  { href: "/staff/ai", label: "AI engine", permissions: ["ai.engine_set"] },
  { href: "/staff/commissions", label: "Agent commissions", permissions: ["commission.manage"] },
  { href: "/staff/ad-leads", label: "Ad leads", permissions: ["ad_leads.manage"] },
  { href: "/staff/meta-leads", label: "Facebook / Instagram keys", permissions: ["ad_leads.manage"] },
  { href: "/staff/ad-leads/rules", label: "Lead routing rules", permissions: ["ad_leads.manage"] },
  { href: "/staff/automation", label: "Automation", permissions: ["automation.manage"] },
  { href: "/staff/valuation-settings", label: "Property valuations", permissions: ["valuation.manage"] },
  { href: "/staff/cron-secrets", label: "Scheduler secrets", permissions: ["config.edit"] },
  { href: "/staff/campaigns", label: "Campaigns", permissions: ["campaign.manage"] },
  { href: "/staff/feeds", label: "Property data feeds", permissions: ["feeds.manage"] },
  { href: "/staff/lead-scoring", label: "Lead scoring", permissions: ["feeds.manage"] },
  { href: "/staff/investments", label: "Investor projects review", permissions: ["investment.review"] },
  { href: "/staff/investments/settings", label: "Investor module switch", permissions: ["investment.manage"] }
];

/** Only the sections this staff member's permissions allow (resolved from the role definition on every request). */
export const sectionsFor = (actor: StaffActor): StaffSection[] => STAFF_SECTIONS.filter(s => s.permissions.some(p => staffCan(actor, p)));

export type CaseKind = "trust_account_verification" | "licence_verification" | "identity_verification" | "other";
export interface CaseState {
  kind: CaseKind; status: "open" | "in_progress" | "resolved"; assignedTo: string | null;
  proposedBy: string | null; proposedByRole: string | null; proposedReason: string | null;
  /** The proposer's permissions when they hold a custom role (built-in roles use the fixed matrix). */
  proposedByPermissions?: readonly StaffPermission[];
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
  const proposer: StaffActor = { id: c.proposedBy, role: c.proposedByRole, ...(c.proposedByPermissions ? { permissions: c.proposedByPermissions } : {}) };
  const d = evaluateOverride(proposer, { target, reason: c.proposedReason }, actor);
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
