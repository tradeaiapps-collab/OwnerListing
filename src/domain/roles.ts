/** Roles a person can hold under one account. Signup picks one (the primary role); the others are activated later. */
export const USER_ROLES = ["buyer", "owner", "agent", "investor"] as const;
export type UserRole = (typeof USER_ROLES)[number];
/** The permission class a session runs as. Investors are buyer accounts (see db/20261025150000_investments.sql), so they run as buyer. */
export type SessionType = "owner" | "agent" | "buyer";

export const ROLE_LABEL: Record<UserRole, string> = { buyer: "Buyer", owner: "Owner", agent: "Agent", investor: "Investor" };
export const ROLE_BLURB: Record<UserRole, string> = {
  buyer: "Search, save and make offers.",
  owner: "List your own home and manage offers.",
  agent: "Work with owners and buyers as a licensed agent.",
  investor: "Browse investor projects (non-binding interest)."
};

export const isUserRole = (v: unknown): v is UserRole => typeof v === "string" && (USER_ROLES as readonly string[]).includes(v);

/** The permission class for a role: every existing permission check keeps working because it only ever sees owner, agent or buyer. */
export const sessionTypeFor = (role: UserRole): SessionType => (role === "investor" ? "buyer" : role);

/** Roles held, primary first, de-duplicated, ignoring anything unknown. The primary role is always held. */
export function heldRoles(userType: string, roles: readonly unknown[] | null | undefined): UserRole[] {
  const primary: UserRole | null = userType === "investor" ? "investor" : isUserRole(userType) ? userType : null;
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
