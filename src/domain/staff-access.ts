export type StaffRole = "super_admin" | "compliance" | "accountant" | "support" | "technical" | "reporting";

export type PermissionArea =
  | "cases" | "trust_accounts" | "identity" | "reports" | "personal_data" | "pricing" | "messaging"
  | "staff" | "website" | "platform" | "overrides";

/** Groups shown in the role builder, in display order. */
export const PERMISSION_AREAS: readonly { key: PermissionArea; label: string }[] = [
  { key: "cases", label: "Admin cases and disputes" },
  { key: "trust_accounts", label: "Trust accounts and licences" },
  { key: "identity", label: "Identity review" },
  { key: "reports", label: "Reports" },
  { key: "personal_data", label: "Personal data" },
  { key: "pricing", label: "Pricing and plans" },
  { key: "messaging", label: "Messaging settings" },
  { key: "staff", label: "Staff management" },
  { key: "website", label: "Website" },
  { key: "platform", label: "Platform and technical" },
  { key: "overrides", label: "Overrides" }
];

export interface PermissionInfo { key: string; area: PermissionArea; label: string; description: string; sensitive: boolean }

/**
 * The permission catalogue: the single source of truth for every staff permission, its label and whether it is sensitive.
 * Only a super admin can put a sensitive permission in a role, and only a super admin can assign a role that holds one.
 * Keys are stable (routes, invites and the audit log refer to them): add new ones, never rename.
 */
export const PERMISSION_CATALOGUE = [
  { key: "case.manage", area: "cases", label: "Work admin cases", description: "Claim and resolve admin cases. Trust account and licence cases still need a second person.", sensitive: false },
  { key: "dispute.read_chat", area: "cases", label: "Read job chat in a dispute", description: "Read the saved job chat for a disputed job. Every view is logged.", sensitive: true },
  { key: "trust_account.approve", area: "trust_accounts", label: "Approve trust accounts", description: "Approve or reject a solicitor trust account. New or changed details always need two different people.", sensitive: true },
  { key: "licence.verify", area: "trust_accounts", label: "Verify agent licences", description: "Check and record agent licence verification.", sensitive: false },
  { key: "identity.review", area: "identity", label: "Review identity documents", description: "Open ID images and selfies and approve or reject identity checks.", sensitive: true },
  { key: "report.sales", area: "reports", label: "Sales report", description: "Listings by status and platform sales figures.", sensitive: false },
  { key: "report.financial", area: "reports", label: "Financial report", description: "Platform revenue, GST and invoice totals.", sensitive: true },
  { key: "report.operations", area: "reports", label: "Operations report", description: "Open cases and the verification funnel.", sensitive: false },
  { key: "report.audit", area: "reports", label: "Audit log", description: "Read the platform audit log (read only).", sensitive: false },
  { key: "report.suburb", area: "reports", label: "Suburb report", description: "Aggregated suburb figures.", sensitive: false },
  { key: "report.seller", area: "reports", label: "Seller reports", description: "A seller's report for their own listing.", sensitive: false },
  { key: "report.buyer", area: "reports", label: "Buyer reports", description: "A buyer's activity report for their own account.", sensitive: false },
  { key: "report.solicitor", area: "reports", label: "Solicitor matter packs", description: "A solicitor's matter pack for their own matter.", sensitive: false },
  { key: "report.broker", area: "reports", label: "Broker referral reports", description: "A broker's referral report for their own account.", sensitive: false },
  { key: "pii.view_masked", area: "personal_data", label: "See masked personal details", description: "Names and contact details partly hidden.", sensitive: false },
  { key: "pii.view_full", area: "personal_data", label: "See full personal details", description: "Full names and contact details.", sensitive: true },
  { key: "pricing.manage", area: "pricing", label: "Set plan prices", description: "Add new plan prices with a reason. Existing subscriptions keep their price.", sensitive: true },
  { key: "messaging.settings", area: "messaging", label: "Email and SMS settings", description: "Enter or change the email and SMS provider details and send test messages.", sensitive: true },
  { key: "staff.manage", area: "staff", label: "Manage staff access", description: "Invite staff, change their role and revoke access, only within the access you hold yourself. Editing roles is for super admins only.", sensitive: true },
  { key: "site.theme.edit", area: "website", label: "Edit website theme", description: "Change the website colours, fonts and logo.", sensitive: false },
  { key: "site.content.edit", area: "website", label: "Edit website content", description: "Draft changes to website pages and blocks.", sensitive: false },
  { key: "site.content.publish", area: "website", label: "Publish website content", description: "Make drafted website content live.", sensitive: false },
  { key: "ai.engine_set", area: "platform", label: "Choose the AI engine", description: "Switch between the template engine and the trained model.", sensitive: true },
  { key: "config.edit", area: "platform", label: "Edit platform settings", description: "Change technical platform settings.", sensitive: false },
  { key: "logs.technical", area: "platform", label: "Technical logs", description: "Read technical logs (no personal data).", sensitive: false },
  { key: "override.request", area: "overrides", label: "Request an override", description: "Ask for a logged override with a reason. Someone else must approve it.", sensitive: false },
  { key: "override.approve", area: "overrides", label: "Approve another person's override", description: "Be the second person on an override, never on your own.", sensitive: true }
] as const satisfies readonly PermissionInfo[];

export type StaffPermission = (typeof PERMISSION_CATALOGUE)[number]["key"];

const ALL: readonly StaffPermission[] = PERMISSION_CATALOGUE.map(p => p.key);
const SENSITIVE: ReadonlySet<string> = new Set(PERMISSION_CATALOGUE.filter(p => p.sensitive).map(p => p.key));
const KNOWN: ReadonlySet<string> = new Set(ALL);

export const isStaffPermission = (v: unknown): v is StaffPermission => typeof v === "string" && KNOWN.has(v);
export const isSensitivePermission = (p: string): boolean => SENSITIVE.has(p);

/** Least privilege: each team sees only what its job needs. Technical staff get no personal data. Built-in roles are fixed in code. */
const ROLE_PERMISSIONS: Record<StaffRole, readonly StaffPermission[]> = {
  super_admin: ALL,
  compliance: ["report.audit", "report.solicitor", "report.broker", "pii.view_full", "case.manage",
    "trust_account.approve", "licence.verify", "dispute.read_chat", "override.request", "identity.review"],
  accountant: ["report.financial", "report.sales", "pii.view_masked"],
  support: ["report.buyer", "report.seller", "pii.view_masked", "case.manage", "override.request"],
  technical: ["logs.technical", "report.operations", "config.edit"],
  reporting: ["report.sales", "report.suburb", "report.operations"]
};

/** Built-in (system) roles and their labels. They cannot be edited, disabled or deleted. */
export const SYSTEM_ROLES: readonly { key: StaffRole; label: string; description: string }[] = [
  { key: "super_admin", label: "Super admin", description: "Everything, including roles and staff access. Safety gates still need a second person." },
  { key: "compliance", label: "Compliance", description: "Trust accounts, licences, identity review, audit and disputes." },
  { key: "accountant", label: "Accountant", description: "Financial and sales reports with masked personal details." },
  { key: "support", label: "Support", description: "Admin cases and owner and buyer reports with masked personal details." },
  { key: "technical", label: "Technical", description: "Technical logs, operations report and platform settings. No personal data." },
  { key: "reporting", label: "Reporting", description: "Sales, suburb and operations reports." }
];

export const isSystemRole = (v: unknown): v is StaffRole => typeof v === "string" && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, v);
export const systemRolePermissions = (role: string): readonly StaffPermission[] => (isSystemRole(role) ? ROLE_PERMISSIONS[role] : []);

/**
 * A signed-in staff member. `role` is the role key on their active invite (built-in or custom). For a custom role, `permissions` is
 * resolved from the database role definition on every request; built-in roles always use the fixed matrix above. A custom role key
 * without `permissions` has no access at all (fail closed).
 */
export interface StaffActor { id: string; role: string; permissions?: readonly StaffPermission[] }

export const effectivePermissions = (actor: StaffActor): readonly StaffPermission[] =>
  isSystemRole(actor.role) ? ROLE_PERMISSIONS[actor.role] : (actor.permissions ?? []);

export function staffCan(actor: StaffActor, p: StaffPermission): boolean {
  return effectivePermissions(actor).includes(p);
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
