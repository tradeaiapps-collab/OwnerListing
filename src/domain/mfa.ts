import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Multi-factor sign-in rules. Pure: no clock, database or environment is read here (callers pass them in).
 * Authenticator apps use TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), which every common app supports.
 */

export type MfaMethod = "totp" | "sms";
export type UserType = "owner" | "agent" | "buyer" | "vendor";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step too, for clock drift between the phone and the server. */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
/** A sensitive action (publish, accept an offer) needs a check this recent, even inside a signed-in session. */
export const STEP_UP_SECONDS = 15 * 60;
export const SMS_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_SMS_CODE_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;

/** Code checks: 10 per user and 30 per IP per 10 minutes. With 6 digits that keeps a guess at well under 1 in 10,000 a day. */
export const MFA_VERIFY_RATE = { windowMs: 10 * 60 * 1000, perUser: 10, perIp: 30 } as const;
/** SMS sends: 5 per user and 10 per IP per hour, and 3 per number per hour. */
export const MFA_SMS_RATE = { windowMs: 60 * 60 * 1000, perUser: 5, perIp: 10, perPhone: 3 } as const;

/** Owners and agents must use a second factor. Anyone who has enrolled one must use it too. */
export const mfaRequired = (userType: UserType, enrolled: boolean): boolean => userType === "owner" || userType === "agent" || enrolled;

/**
 * Whether the session's MFA claim still stands. `verifiedAt` is when this session passed MFA (seconds); `revokedAt` is the latest
 * time a method was removed or reset for the user (seconds), which ends every session verified before it.
 */
export function mfaClaimValid(verifiedAt: number | undefined, revokedAt: number | undefined): boolean {
  if (verifiedAt === undefined) return false;
  return revokedAt === undefined || verifiedAt >= revokedAt;
}

/** True when a sensitive action may go ahead without a fresh check. */
export const stepUpSatisfied = (verifiedAt: number | undefined, nowSeconds: number): boolean =>
  verifiedAt !== undefined && verifiedAt <= nowSeconds + 60 && nowSeconds - verifiedAt <= STEP_UP_SECONDS;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case-insensitive, spaces and padding ignored). Undefined for any other character. */
export function base32Decode(s: string): Uint8Array | undefined {
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) return undefined;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(TOTP_SECRET_BYTES));

/** RFC 4226 HOTP value for one counter. */
export function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (nowSeconds: number): number => Math.floor(nowSeconds / TOTP_STEP_SECONDS);

const sameDigits = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks a TOTP code. Returns the matched time step, or undefined. A step at or below `lastUsedStep` is refused, so a code
 * (or an older one) cannot be replayed; the caller stores the returned step.
 */
export function verifyTotp(secretB32: string, code: string, nowSeconds: number, lastUsedStep = 0): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const secret = base32Decode(secretB32);
  if (!secret || secret.length < 10) return undefined;
  const now = totpStep(nowSeconds);
  let matched: number | undefined;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    // Every candidate is computed and compared, so the time taken does not reveal which step matched.
    if (sameDigits(hotp(secret, s), code) && s > lastUsedStep) matched = s;
  }
  return matched;
}

/** The otpauth:// address an authenticator app reads (from a QR code, or tapped on the phone). */
export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

/** Ten recovery codes like "k7mq-2xvd-pa", lowercase base32 without look-alike confusion (no 0, 1, 8 or 9 in base32). */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const s = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 10)}`;
  });
}

/** The canonical form a recovery code is hashed in: lowercase, no spaces or dashes. Undefined if it cannot be one. */
export function normaliseRecoveryCode(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 40) return undefined;
  const s = raw.replace(/[\s-]/g, "").toLowerCase();
  return /^[a-z2-7]{10}$/.test(s) ? s : undefined;
}

/** Keyed hash for SMS codes, recovery codes and rate-limit buckets. The key is derived from MFA_SECRET_KEY and used for nothing else. */
export function mfaHash(key: string, purpose: string, value: string): string {
  return createHmac("sha256", `${key}:mfa-hash:v1`).update(`${purpose}:${value}`).digest("hex");
}

/** MFA_SECRET_KEY: 32 random bytes, base64 (openssl rand -base64 32). Anything else switches MFA set-up and sign-in checks off. */
export const mfaKeyUsable = (key: string | undefined): key is string => /^[A-Za-z0-9+/]{43}=$/.test(key?.trim() ?? "");
