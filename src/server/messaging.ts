import { createHmac } from "node:crypto";
import { readBrand } from "../config/brand";
import { alertDeliveryFromEnv } from "../adapters/alert-delivery";
import { createDevFileEmail, devFileEmailWanted } from "../adapters/email-dev";
import { emailFromConfig, type EmailMessage, type EmailPort, type HostResolver, type TransportFactory } from "../adapters/email";
import { failed, type SendResult } from "../adapters/messaging";
import { SmsSendError, smsFromConfig, verificationCodeText, type SmsTextPort } from "../adapters/sms";
import type { AlertDeliveryPort, AlertMessage } from "../domain/alerts";
import { htmlFromText } from "../domain/email-templates";
import type { Queryable } from "./db";
import { loadResolved } from "./messaging-settings-db";

type Env = Readonly<Record<string, string | undefined>>;
export interface MessagingDeps { fetch?: typeof fetch; createTransport?: TransportFactory; resolve?: HostResolver }

/** Keyed hash of the recipient for the outbox (a plain hash of a phone number can be reversed by enumeration). Null if no server secret. */
export function recipientHash(env: Env, channel: "email" | "sms", recipient: string): string | null {
  const secret = env["SESSION_SECRET"];
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(`messaging:${channel}:${recipient.toLowerCase()}`).digest("hex");
}

/**
 * Inserts one outbox row. Template, status, provider reference and a fixed error code only: no body, address or number.
 * A failure to write the row is swallowed (the message may already have gone, and re-sending it would be worse), but the
 * insert-only table is the record, so it is awaited before the caller continues.
 */
export async function recordOutbox(db: Queryable, env: Env, channel: "email" | "sms", template: string, recipient: string, r: SendResult): Promise<void> {
  try {
    await db.query(
      "INSERT INTO messaging_outbox (channel, template, recipient_hash, status, provider_ref, error_code) VALUES ($1, $2, $3, $4, $5, $6)",
      [channel, template, recipientHash(env, channel, recipient), r.status, r.status === "sent" ? (r.providerRef ?? null) : null, r.status === "failed" ? r.errorCode : null]);
  } catch {
    // Nothing identifying is logged.
  }
}

export interface OutboxEntry { channel: "email" | "sms"; template: string; status: "sent" | "failed" | "not_configured"; errorCode: string | null; at: string }

/** The newest email and SMS log rows for the staff page. Template, status and error code only: the log holds no address or body. */
export async function recentOutbox(db: Queryable, limit = 50): Promise<OutboxEntry[]> {
  const r = await db.query(
    "SELECT channel, template, status, error_code, created_at FROM messaging_outbox ORDER BY created_at DESC, id DESC LIMIT $1", [limit]);
  return r.rows.map(row => ({
    channel: row["channel"] as OutboxEntry["channel"], template: String(row["template"]), status: row["status"] as OutboxEntry["status"],
    errorCode: typeof row["error_code"] === "string" ? row["error_code"] : null, at: new Date(row["created_at"] as string).toISOString()
  }));
}

/** The SMS port for the settings in force now (environment over database), with every attempt recorded in the outbox. */
export async function getSmsPort(db: Queryable, env: Env, template: string, deps: MessagingDeps = {}): Promise<SmsTextPort> {
  const cfg = (await loadResolved(db, env)).sms;
  const inner = smsFromConfig(cfg, deps.fetch ? { fetch: deps.fetch } : {});
  async function sendText(to: string, text: string): Promise<SendResult> {
    const r = await inner.sendText(to, text);
    await recordOutbox(db, env, "sms", template, to, r);
    return r;
  }
  return {
    configured: inner.configured,
    sendText,
    async sendCode(to, code) {
      const r = await sendText(to, verificationCodeText(code));
      if (r.status === "failed") throw new SmsSendError(r.errorCode as never, r.retryable);
      if (r.status === "not_configured") throw new SmsSendError("not_configured");
    }
  };
}

/**
 * The email port for the settings in force now, with every attempt recorded in the outbox (the email log). A message without HTML
 * gets the branded layout around its text. In development, EMAIL_DELIVERY=dev_file writes emails to .dev-mail/ instead of sending.
 */
export async function getEmailPort(db: Queryable, env: Env, template: string, deps: MessagingDeps = {}): Promise<EmailPort> {
  const inner = devFileEmailWanted(env) ? createDevFileEmail() : emailFromConfig((await loadResolved(db, env)).email,
    { ...(deps.createTransport ? { createTransport: deps.createTransport } : {}), ...(deps.resolve ? { resolve: deps.resolve } : {}) });
  return {
    configured: inner.configured,
    async send(msg: EmailMessage) {
      const r = await inner.send(msg.html !== undefined ? msg : { ...msg, html: htmlFromText(readBrand().name, msg.subject, msg.text) });
      await recordOutbox(db, env, "email", template, msg.to, r);
      return r;
    }
  };
}

/** Sends one plain notice email on the settings in force now. True only if it went out; never throws (a notice never blocks the action). */
export async function sendNotice(db: Queryable, template: string, to: string, msg: { subject: string; text: string; html?: string }, env: Env = process.env): Promise<boolean> {
  try {
    const port = await getEmailPort(db, env, template);
    return port.configured && (await port.send({ to, ...msg })).status === "sent";
  } catch {
    return false;
  }
}

/**
 * Alert delivery on the database settings, resolved at send time. Fails closed: with no settings (or no APP_URL for the listing link)
 * nothing is sent and the outbox records "not_configured". The recipient is looked up only after the channel is known to be configured.
 */
export function createDbAlertDelivery(db: Queryable, env: Env, deps: MessagingDeps = {}): AlertDeliveryPort {
  const base = env["APP_URL"]?.replace(/\/+$/, "");
  return {
    async send(msg: AlertMessage) {
      const link = base ? `${base}/listings/${encodeURIComponent(msg.listingId)}` : "";
      if (msg.channel === "sms") {
        const sms = await getSmsPort(db, env, "alert_listing", deps);
        if (!sms.configured || !link) { await recordOutbox(db, env, "sms", "alert_listing", msg.buyerUserId, { status: "not_configured" }); return "not_configured"; }
        const r = await db.query(
          "SELECT phone_e164 FROM buyer_verification WHERE user_id = $1::uuid AND phone_verified_at IS NOT NULL AND phone_e164 IS NOT NULL", [msg.buyerUserId]);
        const to = r.rows[0]?.["phone_e164"];
        if (typeof to !== "string") { await recordOutbox(db, env, "sms", "alert_listing", msg.buyerUserId, failed("no_recipient", false)); return "failed"; }
        const res = await sms.sendText(to, `${readBrand().name}: a new property matches your saved search: ${link} Opt out: ${msg.unsubscribeUrl}`);
        return res.status === "sent" ? "sent" : res.status === "failed" ? "failed" : "not_configured";
      }
      const email = await getEmailPort(db, env, "alert_listing", deps);
      if (!email.configured || !link) { await recordOutbox(db, env, "email", "alert_listing", msg.buyerUserId, { status: "not_configured" }); return "not_configured"; }
      const r = await db.query("SELECT email FROM app_user WHERE id = $1::uuid AND status = 'active'", [msg.buyerUserId]);
      const to = r.rows[0]?.["email"];
      if (typeof to !== "string") { await recordOutbox(db, env, "email", "alert_listing", msg.buyerUserId, failed("no_recipient", false)); return "failed"; }
      const res = await email.send({
        to, subject: "New property matching your saved search",
        text: `A new property matching your saved search has been listed on ${readBrand().name}.\n\nView it: ${link}\n\nYou are receiving this because you asked for alerts. Unsubscribe: ${msg.unsubscribeUrl}\n`
      });
      return res.status === "sent" ? "sent" : res.status === "failed" ? "failed" : "not_configured";
    }
  };
}

/** The delivery port used at runtime: the development console writer when asked for (never in production), otherwise the database-backed one. */
export function alertDeliveryFor(db: Queryable, env: Env): AlertDeliveryPort {
  if (env["ALERT_DELIVERY"] === "console" && env["NODE_ENV"] !== "production") return alertDeliveryFromEnv(env);
  return createDbAlertDelivery(db, env);
}

/** One test message to the signed-in staff member. Email goes to their own account address; SMS to the number they typed. */
export async function sendTestMessage(db: Queryable, env: Env, staffId: string, channel: "sms" | "email", phone: string | undefined, deps: MessagingDeps = {}): Promise<SendResult> {
  if (channel === "sms") {
    const sms = await getSmsPort(db, env, "settings_test", deps);
    if (!sms.configured) return { status: "not_configured" };
    return phone ? sms.sendText(phone, `${readBrand().name} test message. SMS delivery is working.`) : failed("invalid_recipient", false);
  }
  const email = await getEmailPort(db, env, "settings_test", deps);
  if (!email.configured) return { status: "not_configured" };
  const r = await db.query("SELECT email FROM app_user WHERE id = $1::uuid AND status = 'active'", [staffId]);
  const to = r.rows[0]?.["email"];
  if (typeof to !== "string") return failed("no_recipient", false);
  return email.send({ to, subject: `${readBrand().name} test email`, text: `This is a test message from ${readBrand().name}. Email delivery is working.\n` });
}
