import { readBrand } from "../config/brand";
import { adminAlertEmail, staffInviteEmail, type AdminAlertKind } from "../domain/account-emails";
import type { Queryable } from "./db";
import { sendNotice } from "./messaging";

/**
 * Staff emails: the invite and the admin alerts. Offer, message and appointment notices live in notifier.ts (preferences-aware). Each one is a notice: it never blocks or fails the action that caused it,
 * and every attempt (sent, failed or not configured) is in the email log (messaging_outbox). Callers fire these without awaiting.
 */
type Env = Readonly<Record<string, string | undefined>>;
const appUrl = (env: Env) => (env["APP_URL"] ?? "").replace(/\/+$/, "");

/** The invited person is told to sign in. */
export function notifyStaffInvite(db: Queryable, email: string, role: string, env: Env = process.env): Promise<boolean> {
  return sendNotice(db, "staff_invite", email, staffInviteEmail(readBrand(env).name, role, appUrl(env)), env);
}

/** Every active super admin, optionally leaving one out (the person who caused the alert). Count of emails sent. */
export async function notifyAdmins(db: Queryable, kind: AdminAlertKind, detail: string, opts: { exceptUserId?: string } = {}, env: Env = process.env): Promise<number> {
  try {
    const r = await db.query(
      `SELECT DISTINCT i.email, u.id FROM staff_invite i JOIN app_user u ON u.email = i.email
        WHERE i.role = 'super_admin' AND i.revoked_at IS NULL AND i.accepted_at IS NOT NULL AND u.status = 'active' AND u.deleted_at IS NULL`);
    const msg = adminAlertEmail(readBrand(env).name, kind, detail, appUrl(env));
    let sent = 0;
    for (const row of r.rows) {
      const to = String(row["email"]);
      if (String(row["id"]) === opts.exceptUserId) continue;
      if (await sendNotice(db, "admin_alert", to, msg, env)) sent++;
    }
    return sent;
  } catch {
    return 0;
  }
}
