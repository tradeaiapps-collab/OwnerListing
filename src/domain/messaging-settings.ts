/**
 * Messaging settings (SMS and email): field list, validation and how DB values and environment variables combine.
 * Pure. Environment variables override the database per field. Anything invalid or incomplete resolves to "not configured".
 */
export const FIELDS = [
  "sms.provider", "sms.accountSid", "sms.authToken", "sms.apiKeySid", "sms.sender",
  "email.host", "email.port", "email.user", "email.password", "email.from"
] as const;
export type MessagingField = (typeof FIELDS)[number];

/** Write-only: never returned, only reported as set or not set. */
export const SECRET_FIELDS: readonly MessagingField[] = ["sms.authToken", "email.password"];
export const isSecretField = (f: MessagingField): boolean => SECRET_FIELDS.includes(f);
export const isField = (v: unknown): v is MessagingField => typeof v === "string" && (FIELDS as readonly string[]).includes(v);

export const ENV_NAMES: Record<MessagingField, string> = {
  "sms.provider": "SMS_PROVIDER", "sms.accountSid": "SMS_ACCOUNT_SID", "sms.authToken": "SMS_AUTH_TOKEN", "sms.apiKeySid": "SMS_API_KEY_SID",
  "sms.sender": "SMS_SENDER", "email.host": "SMTP_HOST", "email.port": "SMTP_PORT", "email.user": "SMTP_USER",
  "email.password": "SMTP_PASSWORD", "email.from": "SMTP_FROM"
};

export const E164_RE = /^\+[1-9]\d{7,14}$/;
export const isE164 = (v: unknown): v is string => typeof v === "string" && E164_RE.test(v);
const ALPHA_SENDER_RE = /^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/;
const MESSAGING_SERVICE_RE = /^MG[0-9a-fA-F]{32}$/;
export const isMessagingServiceSid = (v: string): boolean => MESSAGING_SERVICE_RE.test(v);
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const EMAIL_RE = /^[^\s<>"',;()\\@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const PRINTABLE = /^[\x21-\x7e]+$/;
export const isEmailAddress = (v: unknown): v is string => typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v);

/** The cleaned value, or an error message. The empty string is handled by the caller (it clears the setting). */
export function validateField(field: MessagingField, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Must be text." };
  const v = field === "sms.authToken" || field === "email.password" ? raw : raw.trim();
  const bad = (error: string) => ({ ok: false as const, error });
  switch (field) {
    case "sms.provider": return v === "twilio" ? { ok: true, value: v } : bad("Provider must be twilio.");
    case "sms.accountSid": return /^AC[0-9a-fA-F]{32}$/.test(v) ? { ok: true, value: v } : bad("Account SID starts with AC and has 34 characters.");
    case "sms.apiKeySid": return /^SK[0-9a-fA-F]{32}$/.test(v) ? { ok: true, value: v } : bad("API key SID starts with SK and has 34 characters.");
    case "sms.authToken": return PRINTABLE.test(v) && v.length >= 16 && v.length <= 128 ? { ok: true, value: v } : bad("Auth token must be 16 to 128 characters with no spaces.");
    case "sms.sender":
      return E164_RE.test(v) || ALPHA_SENDER_RE.test(v) || MESSAGING_SERVICE_RE.test(v)
        ? { ok: true, value: v } : bad("Use a phone number like +61400000000, a sender ID (1 to 11 letters or digits, at least one letter) or a messaging service SID (MG...).");
    case "email.host": return HOST_RE.test(v) ? { ok: true, value: v } : bad("Enter a host name such as smtp.example.com.");
    case "email.port": return /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? { ok: true, value: String(Number(v)) } : bad("Port must be 1 to 65535.");
    case "email.user": return v.length >= 1 && v.length <= 255 && /^[^\x00-\x1f\x7f]+$/.test(v) ? { ok: true, value: v } : bad("User must be 1 to 255 characters.");
    case "email.password": return v.length >= 1 && v.length <= 255 && /^[^\x00-\x1f\x7f]+$/.test(v) ? { ok: true, value: v } : bad("Password must be 1 to 255 characters.");
    case "email.from": return isEmailAddress(v) ? { ok: true, value: v } : bad("Enter a from address such as no-reply@example.com.");
  }
}

export interface SmsConfig { provider: "twilio"; accountSid: string; authToken: string; apiKeySid?: string; sender: string }
export interface SmtpConfig { host: string; port: number; user?: string; password?: string; from: string }
export interface ResolvedMessaging { sms: SmsConfig | null; email: SmtpConfig | null }

type Env = Readonly<Record<string, string | undefined>>;

/** Environment value (if set and valid) wins over the stored value (if valid). Invalid values count as not set. */
export function pick(field: MessagingField, stored: Partial<Record<MessagingField, string>>, env: Env): { value: string; source: "env" | "database" } | undefined {
  const e = env[ENV_NAMES[field]];
  if (e !== undefined && e.trim() !== "") {
    const r = validateField(field, e);
    return r.ok ? { value: r.value, source: "env" } : undefined;
  }
  const s = stored[field];
  if (s !== undefined && s !== "") {
    const r = validateField(field, s);
    return r.ok ? { value: r.value, source: "database" } : undefined;
  }
  return undefined;
}

export function resolveMessaging(stored: Partial<Record<MessagingField, string>>, env: Env): ResolvedMessaging {
  const g = (f: MessagingField) => pick(f, stored, env)?.value;
  const accountSid = g("sms.accountSid");
  const authToken = g("sms.authToken");
  const sender = g("sms.sender");
  const apiKeySid = g("sms.apiKeySid");
  const sms: SmsConfig | null = g("sms.provider") === "twilio" && accountSid && authToken && sender
    ? { provider: "twilio", accountSid, authToken, sender, ...(apiKeySid ? { apiKeySid } : {}) } : null;
  const host = g("email.host");
  const port = g("email.port");
  const from = g("email.from");
  const user = g("email.user");
  const password = g("email.password");
  // Credentials come as a pair; a lone user or password is a half-finished setup, so email stays off.
  const email: SmtpConfig | null = host && port && from && (user === undefined) === (password === undefined)
    ? { host, port: Number(port), from, ...(user !== undefined && password !== undefined ? { user, password } : {}) } : null;
  return { sms, email };
}

/** What the admin screen may show for a non-secret value. Phone numbers, ids and addresses are shown masked. */
const MASKED: readonly MessagingField[] = ["sms.accountSid", "sms.apiKeySid", "sms.sender", "email.user", "email.from"];
export function displayValue(field: MessagingField, value: string): string | undefined {
  if (isSecretField(field)) return undefined;
  if (!MASKED.includes(field)) return value;
  return value.length <= 6 ? "••••" : `••••${value.slice(-4)}`;
}

/** "Send test" is limited per staff member (a refused attempt still counts). */
export const MESSAGING_TEST_RATE = { windowMs: 60 * 60 * 1000, perStaff: 5 } as const;
