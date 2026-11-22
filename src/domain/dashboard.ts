export type DashboardRole = "owner" | "agent" | "buyer" | "investor" | "staff";
export interface DashboardLink { href: string; label: string; text: string }

const SETTINGS: DashboardLink = { href: "/settings", label: "Settings", text: "Language and time zone." };
const PLANS: DashboardLink = { href: "/plans", label: "Plans", text: "Listing fees, with GST shown." };
const BILLING: DashboardLink = { href: "/billing", label: "Billing", text: "Invoices, your plan and payments." };
const ENQUIRIES: DashboardLink = { href: "/enquiries", label: "Enquiries", text: "Messages with buyers and owners." };

const OWNER_TASKS: readonly DashboardLink[] = [
  { href: "/listings/new", label: "List a property", text: "Start a new draft listing." },
  { href: "/listings/mine", label: "My listings", text: "Edit, publish and review offers." },
  { href: "/reports", label: "Report", text: "Enquiries and offers for each of your listings." },
  ENQUIRIES, PLANS, BILLING, SETTINGS
];

const BY_ROLE: Record<DashboardRole, readonly DashboardLink[]> = {
  owner: OWNER_TASKS,
  agent: [...OWNER_TASKS, { href: "/teams", label: "Teams", text: "Your agency: members, tasks, splits and performance." }],
  buyer: [
    { href: "/listings", label: "Browse listings", text: "Search published properties." },
    { href: "/buyer/saved-searches", label: "Saved searches", text: "Alerts for new matches." },
    { href: "/buyer/verification", label: "Verification", text: "Verify once; offers need it." },
    ENQUIRIES,
    { href: "/offers/new", label: "Make an offer", text: "Open from the secure link in a chat." },
    SETTINGS
  ],
  investor: [
    { href: "/investments", label: "Investor projects", text: "Approved projects; interest is non-binding." },
    { href: "/buyer/verification", label: "Verification", text: "Verify once to take part." },
    { href: "/listings", label: "Browse listings", text: "Search published properties." },
    ENQUIRIES, SETTINGS
  ],
  staff: [{ href: "/staff", label: "Staff", text: "Only the sections your role allows." }]
};

/** Task links for a role. Hiding a link is a convenience: every route still enforces access on the server. */
export function dashboardLinks(role: DashboardRole): DashboardLink[] {
  return [...(BY_ROLE[role] ?? [])];
}

/** Staff sign in separately from owners and buyers. A staff session wins, then the user type, else null (signed out). */
export function dashboardRole(staff: boolean, userType: string | undefined, currentRole?: string): DashboardRole | null {
  if (staff) return "staff";
  if (userType === "buyer" && currentRole === "investor") return "investor";
  return userType === "owner" || userType === "agent" || userType === "buyer" ? userType : null;
}
