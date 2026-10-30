import { readBrand } from "../config/brand";
import { adminAlertEmail, offerOutcomeEmail, offerReceivedEmail, staffInviteEmail, type AdminAlertKind, type OfferOutcome, type RenderedEmail } from "../domain/email-templates";
import type { Queryable } from "./db";
import { sendNotice } from "./messaging";

/**
 * Notification emails for things that happen in the app. Each one is a notice: it never blocks or fails the action that caused it,
 * and every attempt (sent, failed or not configured) is in the email log (messaging_outbox). Callers fire these without awaiting.
 */
type Env = Readonly<Record<string, string | undefined>>;
const appUrl = (env: Env) => (env["APP_URL"] ?? "").replace(/\/+$/, "");

/** The address of a live account, or undefined (closed, deleted or unknown accounts get nothing). */
async function liveEmail(db: Queryable, userId: string): Promise<string | undefined> {
  const r = await db.query("SELECT email FROM app_user WHERE id = $1::uuid AND status = 'active' AND deleted_at IS NULL", [userId]);
  const e = r.rows[0]?.["email"];
  return typeof e === "string" && e !== "" ? e : undefined;
}

async function toUser(db: Queryable, userId: string, template: string, msg: RenderedEmail, env: Env): Promise<boolean> {
  try {
    const to = await liveEmail(db, userId);
    return to ? await sendNotice(db, template, to, msg, env) : false;
  } catch {
    return false;
  }
}

/** The owner hears about a new offer. */
export function notifyOfferReceived(db: Queryable, ownerUserId: string, listingId: string, listingTitle: string, priceCents: number, env: Env = process.env): Promise<boolean> {
  const link = `${appUrl(env)}/listings/${encodeURIComponent(listingId)}/offers`;
  return toUser(db, ownerUserId, "offer_received", offerReceivedEmail(readBrand(env).name, listingTitle, priceCents, link), env);
}

/** The buyer hears the owner's decision or counter-offer. The buyer and listing are read from the offer itself. */
export async function notifyOfferOutcome(db: Queryable, offerId: string, outcome: OfferOutcome, env: Env = process.env): Promise<boolean> {
  try {
    const r = await db.query(
      `SELECT o.buyer_user_id, o.listing_id, l.title FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid`, [offerId]);
    const row = r.rows[0];
    if (!row) return false;
    const base = appUrl(env);
    const link = outcome === "rejected" ? `${base}/listings/${encodeURIComponent(String(row["listing_id"]))}` : `${base}/offers/${encodeURIComponent(offerId)}`;
    return await toUser(db, String(row["buyer_user_id"]), `offer_${outcome}`, offerOutcomeEmail(readBrand(env).name, outcome, String(row["title"]), link), env);
  } catch {
    return false;
  }
}

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
