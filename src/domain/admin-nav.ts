import type { StaffSection } from "./staff-admin";

/** Icons drawn by app/admin-icons.tsx. */
export type AdminIcon =
  | "overview" | "dashboard" | "listing" | "users" | "building" | "toggle" | "case" | "safety" | "bank" | "id" | "wording"
  | "disclosure" | "evidence" | "audit" | "chart" | "builder" | "report" | "price" | "message" | "palette" | "assistant" | "ai"
  | "team" | "key";

export interface AdminGroup { key: string; label: string }
export interface AdminLink extends StaffSection { icon: AdminIcon; blurb: string; group: string }
export interface AdminNavGroup extends AdminGroup { links: AdminLink[] }

/** Sidebar groups, in display order. */
export const ADMIN_GROUPS: readonly AdminGroup[] = [
  { key: "overview", label: "Overview" },
  { key: "marketplace", label: "Marketplace" },
  { key: "compliance", label: "Trust and compliance" },
  { key: "insights", label: "Insights" },
  { key: "settings", label: "Configuration" },
  { key: "team", label: "Team and access" }
];

/** Group, icon and one-line description for each staff screen (keyed by href). Screens missing here land in Configuration. */
const META: Record<string, { group: string; icon: AdminIcon; blurb: string }> = {
  "/staff/dashboard": { group: "overview", icon: "dashboard", blurb: "Key figures for the last 30 days" },
  "/staff/listings": { group: "marketplace", icon: "listing", blurb: "Review, suspend and reinstate listings" },
  "/staff/sale-events": { group: "insights", icon: "report", blurb: "Audit sold and rented events, add historical sales, void wrong ones" },
  "/staff/users": { group: "marketplace", icon: "users", blurb: "Find, review and suspend accounts" },
  "/staff/users/deleted-accounts": { group: "marketplace", icon: "users", blurb: "Delete accounts and restore them within the recovery window" },
  "/staff/investments": { group: "marketplace", icon: "building", blurb: "Check investor projects before they go live" },
  "/staff/investments/settings": { group: "marketplace", icon: "toggle", blurb: "Turn the investor module on or off" },
  "/staff/commissions": { group: "marketplace", icon: "bank", blurb: "Agent commission deals, overrides and payouts" },
  "/staff/cases": { group: "compliance", icon: "case", blurb: "Claim and resolve admin cases" },
  "/staff/safety": { group: "compliance", icon: "safety", blurb: "Messages held by the safety filter" },
  "/staff/trust-accounts": { group: "compliance", icon: "bank", blurb: "Two-person trust account approvals" },
  "/staff/id-review": { group: "compliance", icon: "id", blurb: "Identity checks waiting for review" },
  "/staff/wording-flags": { group: "compliance", icon: "wording", blurb: "Listings flagged for discriminatory wording" },
  "/staff/disclosures": { group: "compliance", icon: "disclosure", blurb: "State disclosure requirements and versions" },
  "/staff/doc-templates": { group: "compliance", icon: "disclosure", blurb: "Contract, disclosure and agreement templates for e-signing" },
  "/staff/disclosures/reviews": { group: "compliance", icon: "evidence", blurb: "Verify uploaded disclosure evidence" },
  "/staff/audit": { group: "compliance", icon: "audit", blurb: "Every staff action, in order" },
  "/staff/analytics": { group: "insights", icon: "chart", blurb: "Trends across listings, offers and fees" },
  "/staff/elena-insights": { group: "insights", icon: "assistant", blurb: "Elena's read on agents, areas, alerts and next steps" },
  "/staff/report-builder": { group: "insights", icon: "builder", blurb: "Build and export custom reports" },
  "/staff/reports": { group: "insights", icon: "report", blurb: "Sales and operations reports" },
  "/staff/finance": { group: "insights", icon: "price", blurb: "Revenue, invoices, bank transfers and payment issues" },
  "/staff/pricing": { group: "settings", icon: "price", blurb: "Listing packages and fees" },
  "/staff/messaging": { group: "settings", icon: "message", blurb: "Email and SMS delivery settings" },
  "/staff/listing-syndication": { group: "settings", icon: "toggle", blurb: "Share listings on Airbnb, VRBO and Booking.com" },
  "/staff/site": { group: "settings", icon: "palette", blurb: "Brand, colours, fonts and home page" },
  "/staff/assistant": { group: "settings", icon: "assistant", blurb: "Pick the AI assistant (Elena and others), answers and chips" },
  "/staff/ai": { group: "settings", icon: "ai", blurb: "Self-hosted AI engine and limits" },
  "/staff/invites": { group: "team", icon: "team", blurb: "Invite staff and manage their access" },
  "/staff/roles": { group: "team", icon: "key", blurb: "What each role can see and do" },
  "/staff/security/mfa-reset": { group: "team", icon: "key", blurb: "Reset a user's two-step sign-in after a lost phone" }
};

export const adminLink = (s: StaffSection): AdminLink => {
  const m = META[s.href] ?? { group: "settings", icon: "overview" as const, blurb: "" };
  return { ...s, ...m };
};

/** The allowed sections arranged into sidebar groups; empty groups are left out. */
export function groupSections(sections: readonly StaffSection[]): AdminNavGroup[] {
  const links = sections.map(adminLink);
  return ADMIN_GROUPS.map(g => ({ ...g, links: links.filter(l => l.group === g.key) })).filter(g => g.links.length > 0);
}

/** The section a path belongs to: the longest href that equals the path or is a parent of it. */
export function activeHref(path: string, sections: readonly StaffSection[]): string | null {
  const clean = path.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";
  let best: string | null = null;
  for (const s of sections) {
    if ((clean === s.href || clean.startsWith(`${s.href}/`)) && (best === null || s.href.length > best.length)) best = s.href;
  }
  return best;
}
