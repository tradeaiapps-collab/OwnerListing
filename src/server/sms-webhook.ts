import { errorCodeOf, isStopKeyword, mapProviderStatus, twilioSignatureValid } from "../domain/sms";
import { isE164 } from "../domain/messaging-settings";
import type { Queryable } from "./db";
import { loadResolved } from "./messaging-settings-db";
import { applySmsStatus, applySmsStop } from "./sms-log";

type Env = Readonly<Record<string, string | undefined>>;
export interface WebhookReply { status: number; body: string; contentType: "application/json" | "text/xml" }

export const MAX_WEBHOOK_BYTES = 16 * 1024;
const json = (status: number, body: Record<string, unknown>): WebhookReply => ({ status, body: JSON.stringify(body), contentType: "application/json" });
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** The public URL Twilio calls. Built from APP_URL, never from the request: behind a proxy the request URL is not what Twilio signed. */
export function webhookUrl(env: Env, path: "status" | "inbound"): string | undefined {
  const base = env["APP_URL"]?.replace(/\/+$/, "");
  return base && /^https:\/\//.test(base) ? `${base}/api/webhooks/twilio/${path}` : undefined;
}

/**
 * Token the signature is checked with: SMS_WEBHOOK_AUTH_TOKEN if set (needed when sending with an API key, because Twilio signs with the
 * account auth token), otherwise the saved/auth token when no API key is in use. Anything else: none, and every webhook is refused.
 */
async function signingToken(db: Queryable, env: Env): Promise<string | undefined> {
  const explicit = env["SMS_WEBHOOK_AUTH_TOKEN"];
  if (explicit) return explicit;
  const sms = (await loadResolved(db, env)).sms;
  return sms && !sms.apiKeySid ? sms.authToken : undefined;
}

/** Common checks: size, URL configured, token available, signature valid. Returns the fields, or the reply to send. */
async function verified(db: Queryable, env: Env, path: "status" | "inbound", rawBody: string, signature: string | null): Promise<URLSearchParams | WebhookReply> {
  if (rawBody.length > MAX_WEBHOOK_BYTES) return json(413, { error: "Too large." });
  const url = webhookUrl(env, path);
  const token = await signingToken(db, env);
  if (!url || !token) return json(503, { error: "Webhook not configured." });
  const params = new URLSearchParams(rawBody);
  if (!twilioSignatureValid(token, url, params, signature)) return json(403, { error: "Bad signature." });
  return params;
}

/** Delivery status callback: MessageSid, MessageStatus, ErrorCode (and Price/PriceUnit when the provider sends them). */
export async function handleSmsStatusWebhook(db: Queryable, env: Env, rawBody: string, signature: string | null): Promise<WebhookReply> {
  const p = await verified(db, env, "status", rawBody, signature);
  if (!(p instanceof URLSearchParams)) return p;
  const ref = p.get("MessageSid") ?? p.get("SmsSid");
  const status = mapProviderStatus(p.get("MessageStatus") ?? p.get("SmsStatus"));
  if (!ref || !/^[A-Za-z]{2}[0-9a-f]{32}$/.test(ref) || !status) return json(200, { ok: true, ignored: true });
  const outcome = await applySmsStatus(db, {
    ref, status, errorCode: errorCodeOf(p.get("ErrorCode") ?? undefined) ?? null,
    price: p.get("Price") ?? undefined, priceUnit: p.get("PriceUnit") ?? undefined
  });
  return json(200, { ok: true, outcome });
}

/** Inbound text. STOP (and the other carrier stop words) switches the sender's texts off. Always answers with empty TwiML: the provider sends its own opt-out confirmation. */
export async function handleSmsInboundWebhook(db: Queryable, env: Env, rawBody: string, signature: string | null): Promise<WebhookReply> {
  const p = await verified(db, env, "inbound", rawBody, signature);
  if (!(p instanceof URLSearchParams)) return p;
  const from = p.get("From");
  if (isStopKeyword(p.get("Body")) && isE164(from)) await applySmsStop(db, from);
  return { status: 200, body: TWIML_EMPTY, contentType: "text/xml" };
}
