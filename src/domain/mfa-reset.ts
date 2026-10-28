import type { StaffActor } from "./staff-access";
import { staffCan } from "./staff-access";

/**
 * Staff reset of a user's second sign-in step (lost or replaced phone). Pure: the route reads the target and writes the reset.
 * Super admin only: the sensitive permission user.mfa_reset and the super_admin role itself, so a custom role given the permission
 * still cannot reset. The staff member must type the account's email to confirm and give a reason.
 */

export const MFA_RESET_REASON_MIN = 10;
export const MFA_RESET_REASON_MAX = 300;

export interface MfaResetTarget {
  id: string;
  email: string;
  userType: string;
  status: string;
  /** Live (not revoked) methods, confirmed or still being set up. */
  liveMethods: number;
}

export type MfaResetPlan =
  | { action: "deny"; status: number; error: string }
  | { action: "reset"; reason: string };

const deny = (status: number, error: string): MfaResetPlan => ({ action: "deny", status, error });

export const canResetMfa = (staff: StaffActor): boolean => staff.role === "super_admin" && staffCan(staff, "user.mfa_reset");

/** Normalises an email typed into the lookup or confirmation box. Undefined for anything that is not an email. */
export function lookupEmail(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : undefined;
}

export function planMfaReset(staff: StaffActor, target: MfaResetTarget, input: { confirmEmail: unknown; reason: unknown }): MfaResetPlan {
  if (!canResetMfa(staff)) return deny(403, "Only a super admin can reset two-step sign-in.");
  if (target.id === staff.id) return deny(403, "You cannot reset your own two-step sign-in.");
  if (target.userType === "admin") return deny(403, "Staff accounts are not reset here.");
  if (lookupEmail(input.confirmEmail) !== target.email.toLowerCase()) return deny(400, "Type the account's email exactly to confirm the reset.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MFA_RESET_REASON_MIN || reason.length > MFA_RESET_REASON_MAX) {
    return deny(400, `Give a reason of ${MFA_RESET_REASON_MIN} to ${MFA_RESET_REASON_MAX} characters.`);
  }
  if (target.liveMethods === 0) return deny(409, "This account has no two-step sign-in method to reset.");
  return { action: "reset", reason };
}

/** The notice sent to the user. No link: they sign in from the site as usual, which is the safer habit to teach. */
export function mfaResetEmail(brandName: string, appUrl: string): { subject: string; text: string } {
  const site = appUrl ? ` at ${appUrl}` : "";
  return {
    subject: `Your ${brandName} two-step sign-in was reset`,
    text: [
      "Hello,",
      "",
      `At your request, our team has reset the two-step sign-in on your ${brandName} account. Your old phone, authenticator app and recovery codes no longer work, and you have been signed out everywhere.`,
      "",
      `To get back in, sign in${site} with your Google account as usual. You will then be asked to set up a new phone or authenticator app before you can continue.`,
      "",
      `If you did not ask for this, contact ${brandName} support straight away.`
    ].join("\n")
  };
}
