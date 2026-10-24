import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
export const SMS_CONSENT_VERSION = "2026-10-24";
/** Shown next to the checkbox. The version above is recorded with the consent. */
export const smsConsentText = (brandName: string) =>
  `I agree that ${brandName} may send one text message with a verification code to this mobile number. It is used only to verify my number.`;

/** Send: 5 per user and 10 per IP per hour, and 3 per phone number per hour (stops texting a stranger repeatedly). */
export const SMS_SEND_RATE = { windowMs: 60 * 60 * 1000, perUser: 5, perIp: 10, perPhone: 3 } as const;
/** Code guesses: 10 per user and 30 per IP per 10 minutes, on top of 5 guesses per code. */
export const SMS_VERIFY_RATE = { windowMs: 10 * 60 * 1000, perUser: 10, perIp: 30 } as const;
/** ID check starts: 5 per user per day. */
export const ID_START_RATE = { windowMs: 24 * 60 * 60 * 1000, perUser: 5 } as const;

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Australian mobile (04XX XXX XXX or +61 4XX XXX XXX) as +614XXXXXXXX, or undefined. */
export function normaliseAuMobile(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 30) return undefined;
  const s = raw.replace(/[\s\-()]/g, "");
  const m = /^(?:\+?61|0)(4\d{8})$/.exec(s);
  return m ? `+61${m[1]}` : undefined;
}

export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Keyed hash bound to the user and the code row, so a leaked table cannot be brute-forced offline without the key. */
export function hashCode(secret: string, userId: string, codeId: string, code: string): string {
  return createHmac("sha256", secret).update(`${userId}:${codeId}:${code}`).digest("hex");
}

/** Constant-time compare of two hex hashes; anything malformed is a mismatch. */
export function hashesEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export const secretUsable = (s: string | undefined): s is string => typeof s === "string" && s.length >= 32;
