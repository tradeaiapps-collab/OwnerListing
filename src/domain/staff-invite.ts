import { staffCan, type StaffActor, type StaffRole } from "./staff-access";

export const STAFF_ROLES: readonly StaffRole[] = ["super_admin", "compliance", "accountant", "support", "technical", "reporting", "designer"];
export const asStaffRole = (v: unknown): StaffRole | null => (typeof v === "string" && (STAFF_ROLES as readonly string[]).includes(v) ? (v as StaffRole) : null);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * The one canonical form of an email for the staff allowlist: trimmed and lower-cased. Returns null for anything that is not a plain
 * ASCII address (inner whitespace, control characters, look-alike Unicode, more than 254 characters), so a tricked address can never match.
 */
export function normaliseStaffEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[\x21-\x7e]+$/.test(e) && EMAIL_RE.test(e) ? e : null;
}

/** STAFF_BOOTSTRAP_ADMIN_EMAILS: comma list. Invalid entries are dropped. */
export const parseBootstrapEmails = (raw: string | undefined): string[] =>
  [...new Set((raw ?? "").split(",").map(normaliseStaffEmail).filter((e): e is string => e !== null))];

export type InviteInput = { ok: true; email: string; role: StaffRole } | { ok: false; error: string };
export function parseInviteInput(body: unknown): InviteInput {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const email = normaliseStaffEmail(b["email"]);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  const role = asStaffRole(b["role"]);
  if (!role) return { ok: false, error: "Choose a role." };
  return { ok: true, email, role };
}

export interface ActiveInvite { id: string; email: string; role: StaffRole }
export type InviteDenyReason = "not_allowed" | "not_found" | "self" | "last_admin" | "unchanged";
export type InvitePlan = { ok: true } | { ok: false; status: number; error: string; reason: InviteDenyReason };

const no = (status: number, error: string, reason: InviteDenyReason): InvitePlan => ({ ok: false, status, error, reason });

/**
 * Whether `actor` may revoke (newRole null) or change the role of `target`. Needs staff.manage; never your own access (including your
 * own role); never removes or demotes the last active super_admin.
 */
export function planInviteChange(actor: StaffActor, target: ActiveInvite | null, isSelf: boolean, activeAdmins: number, newRole: StaffRole | null): InvitePlan {
  if (!staffCan(actor, "staff.manage")) return no(403, "Not allowed.", "not_allowed");
  if (!target) return no(404, "Invite not found.", "not_found");
  if (isSelf) return no(409, "You cannot change your own access.", "self");
  if (newRole !== null && newRole === target.role) return no(409, "That is already the role.", "unchanged");
  if (target.role === "super_admin" && newRole !== "super_admin" && activeAdmins <= 1) return no(409, "The last admin cannot be removed.", "last_admin");
  return { ok: true };
}
