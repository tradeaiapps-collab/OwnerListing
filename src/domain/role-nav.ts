import type { UserRole } from "./roles";

export interface RoleNavItem { id: string; label: string; href: string }

/**
 * Main navigation for a signed-in (non-staff) person, by the role they are viewing as.
 * Only hides links; every route still enforces access on the server. "Account" is last on every role; Sign out is rendered by SiteNav for all roles.
 */
const ACCOUNT: RoleNavItem = { id: "account", label: "Account", href: "/settings" };
const MESSAGES: RoleNavItem = { id: "messages", label: "Messages", href: "/messages" };

export const ROLE_NAV: Record<UserRole, readonly RoleNavItem[]> = {
  owner: [
    { id: "mine", label: "My listings", href: "/listings/mine" },
    { id: "offers", label: "Offers", href: "/listings/mine" },
    MESSAGES,
    { id: "agent-performance", label: "Agent performance", href: "/owner/agent-performance" },
    ACCOUNT
  ],
  buyer: [
    { id: "browse", label: "Browse", href: "/listings" },
    { id: "search", label: "Search", href: "/listings#listing-search" },
    { id: "my-offers", label: "My offers", href: "/offers" },
    { id: "searches", label: "Saved searches", href: "/buyer/saved-searches" },
    MESSAGES,
    ACCOUNT
  ],
  agent: [
    { id: "agent-listings", label: "Listings", href: "/agent/listings" },
    { id: "crm", label: "CRM", href: "/agent/leads" },
    MESSAGES,
    { id: "reports", label: "Reports", href: "/agent/reports" },
    { id: "workspace", label: "Workspace", href: "/agent/workspace" },
    ACCOUNT
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
