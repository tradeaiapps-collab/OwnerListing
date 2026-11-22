/** Left menu of the Account area. Links only guide; every page and API still enforces access on the server. */
export interface AccountMenuItem { id: string; label: string; href: string }
export interface AccountMenuGroup { id: string; title: string; items: readonly AccountMenuItem[] }

export const ACCOUNT_MENU: readonly AccountMenuGroup[] = [
  { id: "profile-security", title: "Profile and security", items: [
    { id: "profile", label: "Profile", href: "/settings" },
    { id: "security", label: "Email and password", href: "/settings/security" },
    { id: "mfa", label: "Two-step sign-in", href: "/mfa" },
    { id: "verification", label: "Verification", href: "/buyer/verification" },
    { id: "roles", label: "Roles", href: "/settings/roles" },
    { id: "developer", label: "Developer keys", href: "/settings/developer" }
  ] },
  { id: "property", title: "My property", items: [
    { id: "listings", label: "My listings", href: "/listings/mine" },
    { id: "offers", label: "Offers", href: "/offers" },
    { id: "searches", label: "Saved searches", href: "/buyer/saved-searches" },
    { id: "saved", label: "Saved listings", href: "/buyer/saved-listings" },
    { id: "messages", label: "Messages", href: "/messages" },
    { id: "enquiries", label: "Enquiries", href: "/enquiries" },
    { id: "documents", label: "Documents", href: "/signing" }
  ] },
  { id: "money", title: "Money", items: [
    { id: "billing", label: "Billing and invoices", href: "/billing" },
    { id: "plans", label: "Plans", href: "/plans" }
  ] },
  { id: "help", title: "Help", items: [
    { id: "notifications", label: "Notifications", href: "/notifications" },
    { id: "language", label: "Language and time zone", href: "/settings/language" },
    { id: "privacy", label: "Privacy and data", href: "/privacy" },
    { id: "support", label: "Help and support", href: "/support" }
  ] }
];

/** The menu item whose page the path belongs to (longest matching href wins), or null. */
export function activeAccountItem(path: string): AccountMenuItem | null {
  let best: AccountMenuItem | null = null;
  for (const g of ACCOUNT_MENU) for (const it of g.items) {
    if ((path === it.href || path.startsWith(`${it.href}/`)) && (!best || it.href.length > best.href.length)) best = it;
  }
  return best;
}
