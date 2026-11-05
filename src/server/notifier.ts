import { readBrand } from "../config/brand";
import { renderEmail } from "../domain/email-templates";
import { planChannels, renderNotification, type Kind, type NotificationParams } from "../domain/notifications";
import type { Queryable } from "./db";
import { getEmailPort, getSmsPort } from "./messaging";
import { createNotificationPg, getPreferencesPg, makeNotificationUnsubscribeToken, recipientPg } from "./notifications-db";

type Env = Readonly<Record<string, string | undefined>>;
export interface NotifyResult { inApp: boolean; email: "sent" | "skipped" | "failed"; sms: "sent" | "skipped" | "failed" }

/**
 * Tells one user about something, on the channels they have chosen (preferences are read at send time, so an opt-out is honoured at once).
 * In-app is the record and is written first; email and SMS go through the logged messaging ports. Never throws: a notification must not
 * block the action that caused it. Marketing email carries a signed one-click unsubscribe link and is refused without one.
 */
export async function notifyUser(db: Queryable, userId: string, kind: Kind, params: NotificationParams = {}, env: Env = process.env): Promise<NotifyResult> {
  const result: NotifyResult = { inApp: false, email: "skipped", sms: "skipped" };
  try {
    const n = renderNotification(kind, params);
    const [prefs, to] = await Promise.all([getPreferencesPg(db, userId), recipientPg(db, userId)]);
    const plan = planChannels(kind, prefs, to.phone !== null);
    const base = env["APP_URL"]?.replace(/\/+$/, "");
    if (plan.inApp) { await createNotificationPg(db, userId, n); result.inApp = true; }

    if (plan.email && to.email) {
      const unsub = n.category === "marketing" && base
        ? (() => { const t = makeNotificationUnsubscribeToken(userId, "marketing", env["ALERT_UNSUBSCRIBE_KEY"]); return t ? `${base}/api/notifications/unsubscribe?t=${encodeURIComponent(t)}` : null; })()
        : null;
      if (n.category !== "marketing" || unsub) {
        const mail = renderEmail({
          brand: readBrand().name, title: n.title, body: n.body, actionUrl: base && n.link ? `${base}${n.link}` : null, actionLabel: "View details",
          reason: n.category === "account" ? "You are receiving this required account notice." : "You are receiving this because of your notification settings.",
          settingsUrl: base ? `${base}/notifications?tab=preferences` : null, unsubscribeUrl: unsub
        });
        const port = await getEmailPort(db, env, `notif_${kind}`);
        result.email = port.configured && (await port.send({ to: to.email, ...mail })).status === "sent" ? "sent" : "failed";
      }
    }
    if (plan.sms && to.phone && n.smsText) {
      const port = await getSmsPort(db, env, `notif_${kind}`);
      const text = `${readBrand().name}: ${n.smsText}`.slice(0, 300) + " Turn texts off: Settings > Notifications.";
      result.sms = port.configured && (await port.sendText(to.phone, text)).status === "sent" ? "sent" : "failed";
    }
  } catch {
    // Nothing identifying is logged; the caller carries on.
  }
  return result;
}

/** Tells the buyer of an offer about the owner's decision or counter. The buyer id and address are looked up here, never taken from the request. */
export async function notifyOfferBuyer(db: Queryable, offerId: string, kind: "offer_accepted" | "offer_rejected" | "offer_countered", env: Env = process.env): Promise<void> {
  try {
    const r = await db.query(
      "SELECT o.buyer_user_id, o.listing_id, l.address_text FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid", [offerId]);
    const x = r.rows[0];
    if (x) await notifyUser(db, String(x["buyer_user_id"]), kind, { listing: String(x["address_text"] ?? ""), link: "/offers" }, env);
  } catch {
    // A notification never blocks the decision.
  }
}

/** Tells a listing's owner that an offer arrived. */
export async function notifyOfferOwner(db: Queryable, listingId: string, env: Env = process.env): Promise<void> {
  try {
    const r = await db.query("SELECT owner_user_id, address_text FROM property_listing WHERE id = $1::uuid", [listingId]);
    const x = r.rows[0];
    if (x) await notifyUser(db, String(x["owner_user_id"]), "offer_received", { listing: String(x["address_text"] ?? ""), link: "/listings/mine" }, env);
  } catch {
    // A notification never blocks the offer.
  }
}

/** Tells the other person in an enquiry thread about a new message. Message text is never copied into the notification. */
export async function notifyEnquiryMessage(db: Queryable, enquiryId: string, senderUserId: string, env: Env = process.env): Promise<void> {
  try {
    const r = await db.query(
      `SELECT e.buyer_user_id, l.owner_user_id, l.address_text, s.display_name FROM enquiry e
         JOIN property_listing l ON l.id = e.listing_id JOIN app_user s ON s.id = $2::uuid WHERE e.id = $1::uuid`, [enquiryId, senderUserId]);
    const x = r.rows[0];
    if (!x) return;
    const to = String(x["buyer_user_id"]) === senderUserId ? String(x["owner_user_id"]) : String(x["buyer_user_id"]);
    if (to === senderUserId) return;
    await notifyUser(db, to, "message_received", { listing: String(x["address_text"] ?? ""), name: String(x["display_name"] ?? ""), link: `/enquiries/${enquiryId}` }, env);
  } catch {
    // A notification never blocks the message.
  }
}
