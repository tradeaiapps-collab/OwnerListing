import { readBrand } from "../config/brand";
import { isMessagingServiceSid, resolveMessaging, type SmsConfig } from "../domain/messaging-settings";
import { failed, type SendErrorCode, type SendResult } from "./messaging";

/** Sends one verification code by SMS. We generate, hash and check the code ourselves; the provider only delivers it. */
export interface SmsPort {
  /** False until a real provider is configured. Sending is refused while false. */
  readonly configured: boolean;
  /** `toE164` is an Australian (+614XXXXXXXX) or US (+1...) mobile. Throws if delivery fails. */
  sendCode(toE164: string, code: string): Promise<void>;
}

/** A provider-agnostic SMS port that can also send a general text (used by alerts). Another provider only has to implement this. */
export interface SmsTextPort extends SmsPort {
  /** Never throws for delivery problems: reports them as a result with a fixed error code. */
  sendText(toE164: string, text: string, opts?: SmsSendOptions): Promise<SendResult>;
}

/** `statusCallback` is an https URL the provider posts delivery status to. */
export interface SmsSendOptions { statusCallback?: string }

/** Thrown by sendCode when delivery fails. Carries a fixed code only: no number, URL, credential or provider text. */
export class SmsSendError extends Error {
  constructor(readonly code: SendErrorCode | "not_configured", readonly retryable = false) {
    super(`SMS send failed: ${code}`);
    this.name = "SmsSendError";
  }
}

/** Nothing is configured. Sending is refused. */
export function createUnconfiguredSms(): SmsTextPort {
  return {
    configured: false,
    async sendCode() { throw new SmsSendError("not_configured"); },
    async sendText() { return { status: "not_configured" }; }
  };
}

/** The text of a verification code message. */
export const verificationCodeText = (code: string): string => `Your ${readBrand().name} verification code is ${code}. It expires in 10 minutes. Do not share it.`;

const TWILIO_BASE = "https://api.twilio.com/2010-04-01/Accounts";
export const SMS_TIMEOUT_MS = 10_000;
const MAX_TEXT = 1600;

/** Maps a Twilio HTTP status and error code to our fixed vocabulary. Provider text is never kept. */
export function mapTwilioError(status: number, providerCode: unknown): { code: SendErrorCode; retryable: boolean } {
  if (status === 401 || status === 403 || providerCode === 20003) return { code: "auth_failed", retryable: false };
  if (providerCode === 21610) return { code: "recipient_opted_out", retryable: false };
  if (providerCode === 21211 || providerCode === 21214 || providerCode === 21614 || providerCode === 21408) return { code: "invalid_recipient", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "provider_unavailable", retryable: true };
  return { code: "rejected", retryable: false };
}

/**
 * Twilio-compatible Messages API over fetch. Fixed host (no configurable URL), HTTPS, timeout, no redirects.
 * Retry-safe by design: this adapter never retries by itself (a request that timed out may still have been delivered), it reports
 * `retryable` and the caller's queue decides; a 4xx is never retryable. Nothing is logged here; errors carry a fixed code only.
 * Auth is the account SID and auth token, or an API key SID and its secret (the secret is stored as the auth token).
 */
export function createTwilioSms(cfg: SmsConfig, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): SmsTextPort {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SMS_TIMEOUT_MS;
  const authorization = `Basic ${Buffer.from(`${cfg.apiKeySid ?? cfg.accountSid}:${cfg.authToken}`).toString("base64")}`;
  const url = `${TWILIO_BASE}/${encodeURIComponent(cfg.accountSid)}/Messages.json`;

  async function sendText(toE164: string, text: string, sendOpts: SmsSendOptions = {}): Promise<SendResult> {
    if (!/^\+[1-9]\d{7,14}$/.test(toE164)) return failed("invalid_recipient", false);
    if (text.length === 0 || text.length > MAX_TEXT) return failed("invalid_message", false);
    const form = new URLSearchParams({ To: toE164, Body: text });
    if (sendOpts.statusCallback && /^https:\/\/[^\s]{1,500}$/.test(sendOpts.statusCallback)) form.set("StatusCallback", sendOpts.statusCallback);
    form.set(isMessagingServiceSid(cfg.sender) ? "MessagingServiceSid" : "From", cfg.sender);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: form.toString()
      });
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      return name === "TimeoutError" || name === "AbortError" ? failed("timeout", true) : failed("network", true);
    }
    const body = (await res.json().catch(() => null)) as { sid?: unknown; code?: unknown } | null;
    if (res.ok) {
      const sid = typeof body?.sid === "string" && /^[A-Za-z]{2}[0-9a-f]{32}$/.test(body.sid) ? body.sid : undefined;
      return sid ? { status: "sent", providerRef: sid } : { status: "sent" };
    }
    const m = mapTwilioError(res.status, body?.code);
    return failed(m.code, m.retryable);
  }

  return {
    configured: true,
    sendText,
    async sendCode(toE164, code) {
      const r = await sendText(toE164, verificationCodeText(code));
      if (r.status === "failed") throw new SmsSendError(r.errorCode as SendErrorCode, r.retryable);
      if (r.status === "not_configured") throw new SmsSendError("not_configured");
    }
  };
}

/** Builds the port for already-resolved settings. Null (anything missing or unknown) is the unconfigured port. */
export function smsFromConfig(cfg: SmsConfig | null, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): SmsTextPort {
  return cfg && cfg.provider === "twilio" ? createTwilioSms(cfg, opts) : createUnconfiguredSms();
}

/** Environment-only settings (SMS_* variables). The server uses the database-aware version in src/server/messaging.ts. Any unknown or missing setting fails closed. */
export function smsFromEnv(env: Readonly<Record<string, string | undefined>>): SmsTextPort {
  return smsFromConfig(resolveMessaging({}, env).sms);
}
