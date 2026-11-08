export type StaffRole = "super_admin" | "compliance" | "accountant" | "support" | "technical" | "reporting" | "designer";

export type PermissionArea =
  | "cases" | "trust_accounts" | "identity" | "reports" | "personal_data" | "pricing" | "messaging"
  | "staff" | "website" | "platform" | "overrides" | "investments" | "disclosures" | "documents" | "marketplace" | "commissions" | "projects";

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
  { key: "overrides", label: "Overrides" },
  { key: "investments", label: "Investor projects" },
  { key: "disclosures", label: "Property disclosures" },
  { key: "documents", label: "Document templates" },
  { key: "marketplace", label: "Listings and accounts" },
  { key: "commissions", label: "Agent commissions" },
  { key: "projects", label: "Internal projects" }
];

export interface PermissionInfo { key: string; area: PermissionArea; label: string; description: string; sensitive: boolean }

/**
 * The permission catalogue: the single source of truth for every staff permission, its label and whether it is sensitive.
 * Only a super admin can put a sensitive permission in a role, and only a super admin can assign a role that holds one.
 * Keys are stable (routes, invites and the audit log refer to them): add new ones, never rename.
 */
export const PERMISSION_CATALOGUE = [
  { key: "case.manage", area: "cases", label: "Work admin cases", description: "Claim and resolve admin cases. Trust account and licence cases still need a second person.", sensitive: false },
  { key: "wording.review", area: "cases", label: "Review discriminatory wording flags", description: "Clear or uphold listing wording the anti-discrimination filter blocked, with a reason. Nobody reviews their own listing.", sensitive: false },
  { key: "signing.support_view", area: "documents", label: "Read a sent signing document in a dispute", description: "Read a sent or signed document and its audit trail to help settle a dispute. Every view is logged with the reason.", sensitive: true },
  { key: "dispute.read_chat", area: "cases", label: "Read job chat in a dispute", description: "Read the saved job chat for a disputed job. Every view is logged.", sensitive: true },
  { key: "prequal.review", area: "marketplace", label: "Review buyer pre-approvals", description: "Open buyers' mortgage pre-approval letters at /staff/prequalifications, confirm what Elena read (amount, conditions, expiry), then verify them or ask the buyer to send a clearer letter. Shows masked buyer names and the lender letter. Every view and decision is logged.", sensitive: true },
  { key: "holiday.manage", area: "cases", label: "Manage public holidays", description: "Add, change and remove the public holidays by state at /staff/public-holidays. They are left out when cooling-off business days are counted, so a change moves deadlines on deposits. Every change is logged.", sensitive: true },
  { key: "scheduling_template.manage", area: "messaging", label: "Manage Elena scheduling message templates", description: "Edit the platform-wide wording Elena uses to draft inspection confirmations and reminders at /staff/scheduling-templates. Agents can still override it for their own messages. Every change is logged.", sensitive: false },
  { key: "valuation.manage", area: "marketplace", label: "Manage property valuations", description: "Turn buyer-facing property valuations on or off for the whole site or one listing at /staff/valuation-settings, and set the minimum number of comparable sales. Every change is logged.", sensitive: true },
  { key: "listing_optimization.manage", area: "marketplace", label: "Manage listing optimization", description: "Turn Elena's seller listing suggestions on or off, set their thresholds and read how often sellers follow them at /staff/listing-optimization-settings. Every change is logged.", sensitive: false },
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
  { key: "billing.manage", area: "pricing", label: "Reconcile payments and answer payment issues", description: "Confirm bank transfers against invoices and answer customers' payment issues at /staff/finance. Moves no money; every action is logged.", sensitive: true },
  { key: "pricing.manage", area: "pricing", label: "Set plan prices", description: "Add new plan prices with a reason. Existing subscriptions keep their price.", sensitive: true },
  { key: "messaging.settings", area: "messaging", label: "Email and SMS settings", description: "Enter or change the email and SMS provider details and send test messages.", sensitive: true },
  { key: "syndication.manage", area: "marketplace", label: "Manage listing portals", description: "Connect Airbnb, VRBO and Booking.com, set their keys and limits, and retry failed syncs.", sensitive: true },
  { key: "staff.manage", area: "staff", label: "Manage staff access", description: "Invite staff, change their role and revoke access, only within the access you hold yourself. Editing roles is for super admins only.", sensitive: true },
  { key: "theme.edit", area: "website", label: "Edit site appearance", description: "Change the website colours, fonts and logo (draft, preview, publish, revert) at /staff/site, and approve agency white-label brands at /staff/white-label.", sensitive: false },
  { key: "site.content.edit", area: "website", label: "Edit website content", description: "Draft changes to website pages and blocks, including the guide assistant's text at /staff/assistant.", sensitive: false },
  { key: "site.content.publish", area: "website", label: "Publish website content", description: "Make drafted website content live, including turning the guide assistant on or off.", sensitive: false },
  { key: "ai.engine_set", area: "platform", label: "Choose the AI engine", description: "Turn the self-hosted AI on or off and test the model server at /staff/ai (super admin only).", sensitive: true },
  { key: "config.edit", area: "platform", label: "Edit platform settings", description: "Change technical platform settings.", sensitive: false },
  { key: "feeds.manage", area: "platform", label: "Property data feeds", description: "Connect agency CRM and Domain feeds, set their territory and schedule, run them and record data licences at /staff/feeds.", sensitive: true },
  { key: "logs.technical", area: "platform", label: "Technical logs", description: "Read technical logs (no personal data).", sensitive: false },
  { key: "override.request", area: "overrides", label: "Request an override", description: "Ask for a logged override with a reason. Someone else must approve it.", sensitive: false },
  { key: "override.approve", area: "overrides", label: "Approve another person's override", description: "Be the second person on an override, never on your own.", sensitive: true },
  { key: "investment.review", area: "investments", label: "Review investor projects", description: "Approve, reject or send back investor projects, check signed agreements, and see the investor counts. Only while the module is on.", sensitive: false },
  { key: "investment.manage", area: "investments", label: "Investor module switch and fees", description: "Turn the investor module on or off (with the counsel confirmation), set the posting model and fees, and mark platform fees paid or waived.", sensitive: true },
  { key: "disclosure.config_edit", area: "disclosures", label: "Draft disclosure requirements", description: "Draft a new version of a state's required disclosures at /staff/disclosures. A draft does nothing until someone else approves it.", sensitive: false },
  { key: "disclosure.config_approve", area: "disclosures", label: "Approve disclosure requirements", description: "Approve a drafted version so it becomes the publish requirement for that state, sale or rent and use. Never your own draft.", sensitive: true },
  { key: "disclosure.verify", area: "disclosures", label: "Verify owner disclosures", description: "Check the evidence an owner gave for each required disclosure and verify or reject it, with a reason. Never on your own listing.", sensitive: false },
  { key: "doc_template.edit", area: "documents", label: "Draft document templates", description: "Create document templates and save new draft versions at /staff/doc-templates. A draft does nothing until someone else publishes it.", sensitive: false },
  { key: "doc_template.publish", area: "documents", label: "Publish document templates", description: "Make a template version live so owners can generate and send it for signature. Never a version you wrote yourself, and only after counsel has reviewed the wording.", sensitive: true },
  { key: "listing.moderate", area: "marketplace", label: "Moderate listings", description: "Search every listing, suspend a published listing, lift a suspension (the owner must publish again) and send a listing under review back to draft. Always with a reason; every action is logged.", sensitive: false },
  { key: "listing.bulk", area: "marketplace", label: "Bulk listing operations", description: "Act on up to 500 listings at once at /staff/listings: publish (through the publish checks), archive, delete (soft), mark sold or rented, add a tag, change property type, adjust price, reassign the agent and export CSV. Always with a reason; every listing is logged. Never on your own listings for agent changes.", sensitive: false },
  { key: "user.manage", area: "marketplace", label: "Manage user accounts", description: "See user accounts with their verification and compliance status, and suspend or reinstate an account with a reason. Staff accounts are managed in Staff access.", sensitive: true },
  { key: "sale_event.manage", area: "marketplace", label: "Record sold and rented events", description: "See the sold and rented log at /staff/sale-events, add historical sales and rentals, void a wrong or fallen-through one with a reason, and sweep accepted offers that have no event. Every action is logged.", sensitive: false },
  { key: "user.mfa_reset", area: "marketplace", label: "Reset two-step sign-in", description: "Reset an owner's or agent's two-step sign-in when they lose their phone, at /staff/security/mfa-reset (super admin only). Every reset is logged and the user is emailed.", sensitive: true },
  { key: "user.delete", area: "marketplace", label: "Delete and restore accounts", description: "Delete an owner's, agent's or buyer's account (listings archived, open offers cancelled, records kept 7 years) and restore it within the recovery window, at /staff/users/deleted-accounts (super admin only). Every step is logged and the people affected are emailed.", sensitive: true },
  { key: "escrow.manage", area: "trust_accounts", label: "Manage deposits in trust", description: "Open the deposit record for an accepted offer, record deposits the bank shows were received, import trust account bank statements and reconcile them, and ask for a deposit to be released or refunded, at /staff/escrow. The platform holds no money; deposits stay in the solicitor's trust account. Every step is logged.", sensitive: true },
  { key: "escrow.approve", area: "trust_accounts", label: "Approve deposit releases", description: "Approve or reject a request to release a deposit to the seller or refund it to the buyer. Never the person who asked for it. Every decision is logged.", sensitive: true },
  { key: "ad_leads.manage", area: "marketplace", label: "Manage ad leads", description: "See leads from Facebook, Instagram and Google ads at /staff/ad-leads with their full contact details, assign them to agents, track them to enquiry and offer, connect ad accounts, record ad spend and turn automatic follow-up emails on or off. Every action is logged.", sensitive: true },
  { key: "commission.manage", area: "commissions", label: "Manage agent commissions", description: "Record agent commission deals, override amounts with a reason, set payout dates, mark deals earned or cancelled, and confirm a payment was made to the agent, at /staff/commissions. The platform holds no money; this is a record. Every step is logged.", sensitive: true },
  { key: "automation.manage", area: "platform", label: "Workflow rules and scheduled tasks", description: "Create, switch on and off, and delete workflow rules and scheduled tasks at /staff/automation. Rules send notifications to owners, agents and buyers; tasks can archive old listings. Every change is logged.", sensitive: true },
  { key: "project.manage", area: "projects", label: "Propose and run internal projects", description: "Propose projects, add milestones, features and linked PRs, record blockers and move a project on hold or to completed at /staff/projects. Cannot approve. Every action is logged.", sensitive: false },
  { key: "project.review", area: "projects", label: "Approve projects as a stakeholder", description: "Approve or reject a proposed project (finance, product owner, CTO) with a comment. Never a project you proposed or own. Every decision is logged.", sensitive: true },
  { key: "project.tech_lead", area: "projects", label: "Tech lead sign-off on projects", description: "Give the required tech lead sign-off, or reject, on a proposed project with a comment. Never a project you proposed or own. Every decision is logged.", sensitive: true },
  { key: "campaign.manage", area: "messaging", label: "Send email and SMS campaigns", description: "Write campaigns, choose a segment, schedule or send them and read open and click rates at /staff/campaigns. Only people who opted in to marketing are reached. Every send is logged.", sensitive: true }
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
    "trust_account.approve", "licence.verify", "dispute.read_chat", "signing.support_view", "override.request", "identity.review", "investment.review",
    "wording.review", "sale_event.manage", "disclosure.config_edit", "disclosure.config_approve", "disclosure.verify", "doc_template.edit", "doc_template.publish", "listing.moderate", "listing.bulk", "user.manage", "escrow.manage", "escrow.approve", "holiday.manage", "prequal.review"],
  accountant: ["report.financial", "report.sales", "pii.view_masked", "billing.manage", "commission.manage", "escrow.manage"],
  support: ["report.buyer", "report.seller", "pii.view_masked", "case.manage", "signing.support_view", "override.request", "listing.moderate", "scheduling_template.manage"],
  technical: ["logs.technical", "report.operations", "config.edit"],
  reporting: ["report.sales", "report.suburb", "report.operations"],
  /** Site appearance only (theme.edit). No personal data, no reports, no money. */
  designer: ["theme.edit"]
};

/** Built-in (system) roles and their labels. They cannot be edited, disabled or deleted. */
export const SYSTEM_ROLES: readonly { key: StaffRole; label: string; description: string }[] = [
  { key: "super_admin", label: "Super admin", description: "Everything, including roles and staff access. Safety gates still need a second person." },
  { key: "compliance", label: "Compliance", description: "Trust accounts and deposits in trust, licences, identity review, audit, disputes, listing moderation and user accounts." },
  { key: "accountant", label: "Accountant", description: "Financial and sales reports with masked personal details, and deposit records and trust account reconciliation." },
  { key: "support", label: "Support", description: "Admin cases, listing moderation, and owner and buyer reports with masked personal details." },
  { key: "technical", label: "Technical", description: "Technical logs, operations report and platform settings. No personal data." },
  { key: "reporting", label: "Reporting", description: "Sales, suburb and operations reports." },
  { key: "designer", label: "Designer", description: "Site appearance only (colours, fonts, logo). No personal data, reports or money." }
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
