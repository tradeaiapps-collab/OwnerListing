export type StaffRole = "super_admin" | "compliance" | "accountant" | "support" | "technical" | "reporting";

export type StaffPermission =
  | "report.sales" | "report.suburb" | "report.financial" | "report.solicitor" | "report.broker"
  | "report.buyer" | "report.seller" | "report.audit" | "report.operations"
  | "pii.view_masked" | "pii.view_full"
  | "case.manage" | "trust_account.approve" | "licence.verify"
  | "ai.engine_set" | "config.edit" | "logs.technical" | "dispute.read_chat"
  | "override.request" | "override.approve" | "staff.manage" | "pricing.manage" | "identity.review"
  | "investment.review" | "investment.manage";

const ALL: readonly StaffPermission[] = [
  "report.sales", "report.suburb", "report.financial", "report.solicitor", "report.broker",
  "report.buyer", "report.seller", "report.audit", "report.operations",
  "pii.view_masked", "pii.view_full", "case.manage", "trust_account.approve", "licence.verify",
  "ai.engine_set", "config.edit", "logs.technical", "dispute.read_chat",
  "override.request", "override.approve", "staff.manage", "pricing.manage", "identity.review",
  "investment.review", "investment.manage"
];

/** Least privilege: each team sees only what its job needs. Technical staff get no personal data. */
const ROLE_PERMISSIONS: Record<StaffRole, readonly StaffPermission[]> = {
  super_admin: ALL,
  compliance: ["report.audit", "report.solicitor", "report.broker", "pii.view_full", "case.manage",
    "trust_account.approve", "licence.verify", "dispute.read_chat", "override.request", "identity.review", "investment.review"],
  accountant: ["report.financial", "report.sales", "pii.view_masked"],
  support: ["report.buyer", "report.seller", "pii.view_masked", "case.manage", "override.request"],
  technical: ["logs.technical", "report.operations", "config.edit"],
  reporting: ["report.sales", "report.suburb", "report.operations"]
};

export interface StaffActor { id: string; role: StaffRole }

export function staffCan(actor: StaffActor, p: StaffPermission): boolean {
  return ROLE_PERMISSIONS[actor.role].includes(p);
}

export type ReportScope = "own_listing" | "own_matter" | "own_account" | "platform_wide" | "aggregated";

export interface ReportDef {
  id: string;
  audience: "seller" | "buyer" | "solicitor" | "broker" | "public" | "internal";
  scope: ReportScope;
  permission: StaffPermission;
}

/** External reports only contain that person's own listing, matter or account. */
export const REPORTS: readonly ReportDef[] = [
  { id: "seller_sale_report", audience: "seller", scope: "own_listing", permission: "report.seller" },
  { id: "buyer_activity_report", audience: "buyer", scope: "own_account", permission: "report.buyer" },
  { id: "solicitor_matter_pack", audience: "solicitor", scope: "own_matter", permission: "report.solicitor" },
  { id: "broker_referral_report", audience: "broker", scope: "own_account", permission: "report.broker" },
  { id: "suburb_report", audience: "public", scope: "aggregated", permission: "report.suburb" },
  { id: "sales_summary", audience: "internal", scope: "platform_wide", permission: "report.sales" },
  { id: "financial_internal", audience: "internal", scope: "platform_wide", permission: "report.financial" },
  { id: "audit_report", audience: "internal", scope: "platform_wide", permission: "report.audit" },
  { id: "operations_health", audience: "internal", scope: "platform_wide", permission: "report.operations" }
];

export function staffCanGenerate(actor: StaffActor, reportId: string): boolean {
  const r = REPORTS.find(x => x.id === reportId);
  return r !== undefined && staffCan(actor, r.permission);
}

export type OverrideTarget =
  | "listing" | "offer_status" | "user_account" | "config" | "trust_account" | "licence" | "audit_event" | "chat_message";

/** Permanent records are never rewritten; staff add a correcting note instead. */
const IMMUTABLE: readonly OverrideTarget[] = ["audit_event", "chat_message"];
/** Safety gates always need a second person, even for a super admin. */
const DUAL_CONTROL: readonly OverrideTarget[] = ["trust_account", "licence"];

export interface OverrideRequest { target: OverrideTarget; reason: string }
export interface OverrideDecision { allowed: boolean; requiresSecondApprover: boolean; reasons: string[] }

/** Every override is logged by the caller with the actor, target and reason. */
export function evaluateOverride(actor: StaffActor, req: OverrideRequest, approver?: StaffActor): OverrideDecision {
  if (IMMUTABLE.includes(req.target)) {
    return { allowed: false, requiresSecondApprover: false, reasons: ["Permanent record: add a correcting note instead of changing it."] };
  }
  if (!staffCan(actor, "override.request")) {
    return { allowed: false, requiresSecondApprover: false, reasons: ["Your role cannot request overrides."] };
  }
  if (req.reason.trim().length < 10) {
    return { allowed: false, requiresSecondApprover: false, reasons: ["A clear reason is required."] };
  }
  const needsSecond = actor.role !== "super_admin" || DUAL_CONTROL.includes(req.target);
  if (!needsSecond) return { allowed: true, requiresSecondApprover: false, reasons: [] };
  if (!approver || approver.id === actor.id || !staffCan(approver, "override.approve")) {
    return { allowed: false, requiresSecondApprover: true, reasons: ["A different authorised person must approve this override."] };
  }
  return { allowed: true, requiresSecondApprover: true, reasons: [] };
}
