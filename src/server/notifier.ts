import { readBrand } from "../config/brand";
import { renderEmail } from "../domain/email-templates";
import { planChannels, renderNotification, type Kind, type NotificationParams } from "../domain/notifications";
import type { Queryable } from "./db";
import { getEmailPort, getSmsPort } from "./messaging";
import { formatNotificationSms, estimateMicros, segmentMicros } from "../domain/sms";
import { pushToUser } from "./push";
import { recordSmsMessage, smsWithinRate } from "./sms-log";
import { webhookUrl } from "./sms-webhook";
import { createNotificationPg, getPreferencesPg, makeNotificationUnsubscribeToken, recipientPg } from "./notifications-db";

type Env = Readonly<Record<string, string | undefined>>;
export interface NotifyResult { inApp: boolean; email: "sent" | "skipped" | "failed"; sms: "sent" | "skipped" | "failed"; push: "sent" | "skipped" | "failed" }

/**
 * Tells one user about something, on the channels they have chosen (preferences are read at send time, so an opt-out is honoured at once).
 * In-app is the record and is written first; email and SMS go through the logged messaging ports. Never throws: a notification must not
 * block the action that caused it. Marketing email carries a signed one-click unsubscribe link and is refused without one.
 */
export async function notifyUser(db: Queryable, userId: string, kind: Kind, params: NotificationParams = {}, env: Env = process.env, only?: "in_app" | "email" | "sms"): Promise<NotifyResult> {
  const result: NotifyResult = { inApp: false, email: "skipped", sms: "skipped", push: "skipped" };
  try {
    const n = renderNotification(kind, params);
    const [prefs, to] = await Promise.all([getPreferencesPg(db, userId), recipientPg(db, userId)]);
    const full = planChannels(kind, prefs, to.phone !== null);
    // `only` narrows to one channel (an automation step that says "email" sends email only); it never adds a channel the user has not allowed.
    const plan = only ? { inApp: full.inApp && only === "in_app", email: full.email && only === "email", sms: full.sms && only === "sms" } : full;
    const base = env["APP_URL"]?.replace(/\/+$/, "");
    const statusUrl = webhookUrl(env, "status");
    let notificationId: string | null = null;
    if (plan.inApp) { notificationId = await createNotificationPg(db, userId, n); result.inApp = true; }
    // Push goes out alongside, on the user's own topic setting; Elena personalises it. A failure here never affects the other channels.
    if (!only) result.push = (await pushToUser(db, userId, kind, n, notificationId, env)).status;

    if (plan.email && to.email) {
      const unsub = n.category === "marketing" && base
        ? (() => { const t = makeNotificationUnsubscribeToken(userId, "marketing", env["ALERT_UNSUBSCRIBE_KEY"]); return t ? `${base}/api/notifications/unsubscribe?t=${encodeURIComponent(t)}` : null; })()
        : null;
      if (n.category !== "marketing" || unsub) {
        const mail = renderEmail({
          brand: readBrand().name, title: n.title, body: n.body, actionUrl: base && n.link ? `${base}${n.link}` : null, actionLabel: kind.startsWith("signature_") ? "Review and sign" : "View details",
          reason: n.category === "account" ? "You are receiving this required account notice." : "You are receiving this because of your notification settings.",
          settingsUrl: base ? `${base}/notifications?tab=preferences` : null, unsubscribeUrl: unsub
        });
        const port = await getEmailPort(db, env, `notif_${kind}`);
        result.email = port.configured && (await port.send({ to: to.email, ...mail })).status === "sent" ? "sent" : "failed";
      }
    }
    if (plan.sms && to.phone && n.smsText) {
      const port = await getSmsPort(db, env, `notif_${kind}`);
      if (!port.configured) result.sms = "failed";
      else if (!(await smsWithinRate(db, userId))) result.sms = "skipped"; // per-user limit: in-app and email still went
      else {
        const sms = formatNotificationSms(readBrand().name, n.smsText);
        const res = await port.sendText(to.phone, sms.text, { ...(statusUrl ? { statusCallback: statusUrl } : {}) });
        await recordSmsMessage(db, { userId, template: `notif_${kind}`, result: res, segments: Math.max(sms.segments, 1), estMicros: estimateMicros(sms.segments, segmentMicros(env)) });
        result.sms = res.status === "sent" ? "sent" : "failed";
      }
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

/**
 * Tells the owner that the buyer answered with a counter-offer. The owner's id and the address are looked up from the offer, never taken
 * from the request. No price or terms go in the message: the owner opens the offer to see them.
 */
export async function notifyOwnerOfBuyerCounter(db: Queryable, offerId: string, env: Env = process.env): Promise<void> {
  try {
    const r = await db.query("SELECT l.id, l.owner_user_id, l.address_text FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid", [offerId]);
    const x = r.rows[0];
    if (x) await notifyUser(db, String(x["owner_user_id"]), "offer_buyer_countered", { listing: String(x["address_text"] ?? ""), link: `/listings/${String(x["id"])}/offers/${offerId}` }, env);
  } catch {
    // A notification never blocks the counter.
  }
}

/** Tells the owner the buyer agreed to the owner's counter-terms. Nothing is accepted by this; the owner still decides. Never throws. */
export async function notifyOwnerOfTermsAgreed(db: Queryable, offerId: string, env: Env = process.env): Promise<void> {
  try {
    const r = await db.query("SELECT l.id, l.owner_user_id, l.address_text FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid", [offerId]);
    const x = r.rows[0];
    if (x) await notifyUser(db, String(x["owner_user_id"]), "offer_terms_agreed", { listing: String(x["address_text"] ?? ""), link: `/listings/${String(x["id"])}/offers/${offerId}` }, env);
  } catch {
    // A notification never blocks the agreement.
  }
}

/** Buyers who saved, were alerted to, enquired about or made another offer on a listing, except the owner and one excluded buyer. */
const FOLLOWERS_SQL = `SELECT DISTINCT u FROM (
         SELECT buyer_user_id AS u FROM saved_listing WHERE listing_id = $1::uuid
         UNION SELECT buyer_user_id FROM alert_delivery WHERE listing_id = $1::uuid AND saved_search_id IS NOT NULL AND outcome = 'sent'
         UNION SELECT buyer_user_id FROM enquiry WHERE listing_id = $1::uuid
         UNION SELECT buyer_user_id FROM formal_offer WHERE listing_id = $1::uuid
       ) f WHERE u <> $2::uuid AND u <> $3::uuid`;

/**
 * Tells the people following a listing that it is back on the market after a sale fell through (the offer must now be fallen_through).
 * Same audience and settings as notifyListingSold; never the owner or the buyer whose sale fell through. Returns how many were addressed.
 */
export async function notifyListingBackOnMarket(db: Queryable, offerId: string, env: Env = process.env): Promise<number> {
  try {
    const l = (await db.query(
      `SELECT l.id, l.owner_user_id, l.address_text, l.transaction_type, l.status, o.buyer_user_id AS fell
         FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid AND o.status = 'fallen_through'`, [offerId])).rows[0];
    if (!l || l["status"] !== "published") return 0;
    // Someone else's accepted offer means it is not back on the market.
    if ((await db.query("SELECT 1 FROM formal_offer WHERE listing_id = $1::uuid AND status = 'accepted' LIMIT 1", [String(l["id"])])).rows.length > 0) return 0;
    const r = await db.query(FOLLOWERS_SQL, [String(l["id"]), String(l["owner_user_id"]), String(l["fell"])]);
    const params = { listing: String(l["address_text"] ?? ""), link: `/listings/${String(l["id"])}`, rent: l["transaction_type"] === "rent" ? "1" : "0" };
    for (const row of r.rows) await notifyUser(db, String(row["u"]), "listing_back_on_market", params, env);
    return r.rows.length;
  } catch {
    return 0; // A notification never blocks the step that caused it.
  }
}

/**
 * Tells the people following a listing that it has sold (or been rented) once an offer is accepted: buyers who saved it, were alerted to it
 * by a saved search, enquired about it, or made another offer. Never the owner or the winning buyer (they have their own notices).
 * Each person gets one notice, on their own listing-notification settings. Returns how many were addressed.
 */
export async function notifyListingSold(db: Queryable, offerId: string, env: Env = process.env): Promise<number> {
  try {
    const l = (await db.query(
      `SELECT l.id, l.owner_user_id, l.address_text, l.transaction_type, o.buyer_user_id AS winner
         FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE o.id = $1::uuid AND o.status = 'accepted'`, [offerId])).rows[0];
    if (!l) return 0;
    const r = await db.query(FOLLOWERS_SQL, [String(l["id"]), String(l["owner_user_id"]), String(l["winner"])]);
    const params = { listing: String(l["address_text"] ?? ""), link: "/browse", rent: l["transaction_type"] === "rent" ? "1" : "0" };
    for (const row of r.rows) await notifyUser(db, String(row["u"]), "listing_sold", params, env);
    return r.rows.length;
  } catch {
    return 0; // A notification never blocks the sale.
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

const INVITE_SQL =
  "SELECT i.agent_user_id, l.owner_user_id, l.address_text, l.title, a.display_name AS agent_name, o.display_name AS owner_name " +
  "FROM agent_appointment_invite i JOIN property_listing l ON l.id = i.listing_id " +
  "JOIN app_user a ON a.id = i.agent_user_id JOIN app_user o ON o.id = l.owner_user_id WHERE i.id = $1::uuid";
const place = (x: Record<string, unknown>) => String(x["address_text"] ?? x["title"] ?? "");

/** Tells the invited agent about a new invitation from the owner. Ids and names are looked up here, never taken from the request. */
export async function notifyAgentInvited(db: Queryable, inviteId: string, env: Env = process.env): Promise<void> {
  try {
    const x = (await db.query(INVITE_SQL, [inviteId])).rows[0];
    if (x) await notifyUser(db, String(x["agent_user_id"]), "appointment_invited", { listing: place(x), name: String(x["owner_name"] ?? ""), link: "/agent/appointments" }, env);
  } catch {
    // A notification never blocks the invitation.
  }
}

/** Tells the owner that the agent accepted or declined. */
export async function notifyInviteAnswered(db: Queryable, inviteId: string, kind: "appointment_accepted" | "appointment_declined", env: Env = process.env): Promise<void> {
  try {
    const x = (await db.query(INVITE_SQL, [inviteId])).rows[0];
    if (x) await notifyUser(db, String(x["owner_user_id"]), kind, { listing: place(x), name: String(x["agent_name"] ?? ""), link: "/listings/mine" }, env);
  } catch {
    // A notification never blocks the answer.
  }
}

/** Hours an invitation may sit unanswered before the agent gets its one reminder. */
export const INVITE_REMINDER_HOURS = 48;
const CLAIM_REMINDERS_SQL =
  "UPDATE agent_appointment_invite i SET reminded_at = $1::timestamptz FROM property_listing l, app_user o " +
  "WHERE l.id = i.listing_id AND o.id = l.owner_user_id AND i.id IN (" +
  "SELECT id FROM agent_appointment_invite WHERE status = 'proposed' AND reminded_at IS NULL AND created_at <= $1::timestamptz - make_interval(hours => $2::int) " +
  "ORDER BY created_at LIMIT 200 FOR UPDATE SKIP LOCKED) " +
  "RETURNING i.agent_user_id, l.address_text, l.title, o.display_name AS owner_name";

/** Sends one reminder per open invitation older than INVITE_REMINDER_HOURS. Each invitation is claimed (reminded_at set) before sending, so a repeat run never reminds twice. */
export async function runInviteReminders(db: Queryable, nowIso: string, env: Env = process.env): Promise<{ reminded: number }> {
  const { rows } = await db.query(CLAIM_REMINDERS_SQL, [nowIso, INVITE_REMINDER_HOURS]);
  for (const x of rows) await notifyUser(db, String(x["agent_user_id"]), "appointment_reminder", { listing: place(x), name: String(x["owner_name"] ?? ""), link: "/agent/appointments" }, env);
  return { reminded: rows.length };
}

/** Hours a DocuSign signer may sit on a request before the one automatic reminder; and the least time between two manual resends. */
export const SIGNING_REMINDER_HOURS = 72;
export const SIGNING_RESEND_MINUTES = 60;
const SIGNER_COLUMNS = "s.user_id, d.id AS document_id, d.title, o.display_name AS owner_name";
const SIGNER_FROM =
  "FROM signing_signer s JOIN signing_document d ON d.id = s.document_id JOIN app_user o ON o.id = d.created_by " +
  "WHERE d.provider = 'docusign' AND d.status = 'out_for_signature' AND s.status = 'pending'";
const signerParams = (x: Record<string, unknown>) => ({ document: String(x["title"] ?? ""), name: String(x["owner_name"] ?? ""), link: `/signing/${String(x["document_id"])}` });

/**
 * Emails (and notifies in-app) every signer who has not yet responded to a DocuSign document. Embedded signing means DocuSign sends them
 * nothing, so this is how they learn they were asked. Each signer is claimed (notified_at set) before sending, and a signer asked within
 * the last SIGNING_RESEND_MINUTES is skipped, so double clicks and repeat calls never flood anyone. Ids and addresses are looked up here.
 */
export async function sendSigningRequests(db: Queryable, documentId: string, nowIso: string, env: Env = process.env): Promise<{ sent: number; skipped: number }> {
  try {
    const total = Number((await db.query(`SELECT count(*) AS n ${SIGNER_FROM} AND d.id = $1::uuid`, [documentId])).rows[0]?.["n"] ?? 0);
    const { rows } = await db.query(
      `UPDATE signing_signer s SET notified_at = $2::timestamptz FROM signing_document d, app_user o
         WHERE d.id = s.document_id AND o.id = d.created_by AND d.id = $1::uuid AND d.provider = 'docusign' AND d.status = 'out_for_signature' AND s.status = 'pending'
           AND (s.notified_at IS NULL OR s.notified_at <= $2::timestamptz - make_interval(mins => $3::int))
         RETURNING ${SIGNER_COLUMNS}`, [documentId, nowIso, SIGNING_RESEND_MINUTES]);
    for (const x of rows) await notifyUser(db, String(x["user_id"]), "signature_requested", signerParams(x), env);
    return { sent: rows.length, skipped: Math.max(total - rows.length, 0) };
  } catch {
    return { sent: 0, skipped: 0 }; // A notification never blocks sending the document.
  }
}

/** One automatic reminder per signer still pending SIGNING_REMINDER_HOURS after their last request. Claimed (reminded_at set) before sending, so a repeat run never reminds twice. */
export async function runSigningReminders(db: Queryable, nowIso: string, env: Env = process.env): Promise<{ reminded: number }> {
  const { rows } = await db.query(
    `UPDATE signing_signer s SET reminded_at = $1::timestamptz FROM signing_document d, app_user o
       WHERE d.id = s.document_id AND o.id = d.created_by AND s.id IN (
         SELECT s2.id FROM signing_signer s2 JOIN signing_document d2 ON d2.id = s2.document_id
          WHERE d2.provider = 'docusign' AND d2.status = 'out_for_signature' AND s2.status = 'pending' AND s2.reminded_at IS NULL
            AND COALESCE(s2.notified_at, d2.sent_at) <= $1::timestamptz - make_interval(hours => $2::int)
          ORDER BY d2.sent_at LIMIT 200 FOR UPDATE OF s2 SKIP LOCKED)
       RETURNING ${SIGNER_COLUMNS}`, [nowIso, SIGNING_REMINDER_HOURS]);
  for (const x of rows) await notifyUser(db, String(x["user_id"]), "signature_reminder", signerParams(x), env);
  return { reminded: rows.length };
}
