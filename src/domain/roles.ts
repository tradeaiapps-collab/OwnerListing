/** Roles a person can hold under one account. Signup picks one (the primary role); the others are activated later. */
export const USER_ROLES = ["buyer", "owner", "agent", "investor"] as const;
/** Roles any account can hold and switch between. A contractor ("vendor" in the database) is never one of these: it is an account type of its own. */
export type SwitchableRole = (typeof USER_ROLES)[number];
export type UserRole = SwitchableRole | "vendor";
/** The permission class a session runs as. Investors are buyer accounts (see db/20261025150000_investments.sql), so they run as buyer. */
export type SessionType = "owner" | "agent" | "buyer" | "vendor";

export const ROLE_LABEL: Record<UserRole, string> = { buyer: "Buyer", owner: "Owner", agent: "Agent", investor: "Investor", vendor: "Contractor" };
export const ROLE_BLURB: Record<UserRole, string> = {
  buyer: "Search, save and make offers.",
  owner: "List your own home and manage offers.",
  agent: "Work with owners and buyers as a licensed agent.",
  investor: "Browse investor projects (non-binding interest).",
  vendor: "Photographers, inspectors, pest control and other trades taking jobs from owners."
};

/** True for a role an account can add or switch to. "vendor" is false: it can only be a primary account type. */
export const isUserRole = (v: unknown): v is SwitchableRole => typeof v === "string" && (USER_ROLES as readonly string[]).includes(v);

/** The permission class for a role: every existing permission check keeps working because it only ever sees owner, agent or buyer. */
export const sessionTypeFor = (role: UserRole): SessionType => (role === "investor" ? "buyer" : role);

/** Roles held, primary first, de-duplicated, ignoring anything unknown. The primary role is always held. A "vendor" entry in `roles` is ignored: only the account's own type can make it a contractor. */
export function heldRoles(userType: string, roles: readonly unknown[] | null | undefined): UserRole[] {
  const primary: UserRole | null = userType === "investor" ? "investor" : userType === "vendor" ? "vendor" : isUserRole(userType) ? userType : null;
  const out: UserRole[] = primary ? [primary] : [];
  for (const r of roles ?? []) if (isUserRole(r) && !out.includes(r)) out.push(r);
  return out;
}

/** The role a session is viewing as: its `cr` claim when valid and held, else the role matching its permission class. */
export function activeRole(ut: SessionType, cr: unknown, held: readonly UserRole[]): UserRole | null {
  if (isUserRole(cr) && held.includes(cr) && sessionTypeFor(cr) === ut) return cr;
  return held.includes(ut) ? ut : null;
}

/** Where a role's dashboard lives. */
export const homeForRole = (_role: UserRole): string => "/dashboard";
