import type { UserRole } from "./roles";

export interface RoleNavItem { id: string; label: string; href: string }

/**
 * Main navigation for a signed-in (non-staff) person, by the role they are viewing as.
 * Only hides links; every route still enforces access on the server. "Account" is last on every role; Sign out is rendered by SiteNav for all roles.
 */
const ACCOUNT: RoleNavItem = { id: "account", label: "Account", href: "/settings" };
const MESSAGES: RoleNavItem = { id: "messages", label: "Messages", href: "/messages" };
const PROJECTS: RoleNavItem = { id: "projects", label: "Projects", href: "/investments" };

export const ROLE_NAV: Record<UserRole, readonly RoleNavItem[]> = {
  owner: [
    { id: "browse", label: "Browse", href: "/listings" },
    { id: "mine", label: "My listings", href: "/listings/mine" },
    { id: "offers", label: "Offers", href: "/listings/mine#offers" },
    PROJECTS,
    { id: "contractors", label: "Contractors", href: "/contractors" },
    { id: "jobs", label: "Jobs", href: "/jobs" },
    MESSAGES,
    { id: "agent-performance", label: "Agent performance", href: "/owner/agent-performance" },
    ACCOUNT
  ],
  buyer: [
    { id: "browse", label: "Browse", href: "/listings" },
    { id: "search", label: "Search", href: "/listings#listing-search" },
    { id: "my-offers", label: "My offers", href: "/offers" },
    { id: "searches", label: "Saved searches", href: "/buyer/saved-searches" },
    PROJECTS,
    MESSAGES,
    ACCOUNT
  ],
  agent: [
    { id: "agent-listings", label: "Listings", href: "/agent/listings" },
    { id: "crm", label: "CRM", href: "/agent/leads" },
    PROJECTS,
    { id: "jobs", label: "Jobs", href: "/jobs" },
    MESSAGES,
    { id: "reports", label: "Reports", href: "/agent/reports" },
    { id: "workspace", label: "Workspace", href: "/agent/workspace" },
    ACCOUNT
  ],
  vendor: [
    { id: "contractor-profile", label: "My page", href: "/contractor/profile" },
    { id: "contractor-jobs", label: "Jobs", href: "/contractor/jobs" },
    { id: "contractor-public", label: "Public page", href: "/contractors" },
    PROJECTS,
    { id: "contractor-security", label: "Security", href: "/mfa" }
  ],
  investor: [
    { id: "projects", label: "Projects", href: "/investments" },
    { id: "portfolio", label: "Portfolio", href: "/investments/threads" },
    { id: "insights", label: "Insights", href: "/market" },
    MESSAGES,
    ACCOUNT
  ]
};

export const roleNav = (role: UserRole): readonly RoleNavItem[] => ROLE_NAV[role];
