import { randomUUID } from "node:crypto";
import type { SmsPort } from "../adapters/sms";
import {
  CODE_TTL_MS, MAX_CODE_ATTEMPTS, SMS_CONSENT_VERSION, SMS_SEND_RATE, SMS_VERIFY_RATE,
  hashCode, hashesEqual, newCode, normaliseAuMobile, secretUsable, sha256Hex
} from "../domain/phone-verification";
import { withinLimit } from "../domain/rate-limit";
import type { Failure, Result } from "../domain/listing-service";

export type PhoneEvent = "code_sent" | "send_failed" | "code_wrong" | "code_expired" | "code_locked" | "verified" | "rate_limited";

export interface LiveCode { id: string; phoneE164: string; codeHash: string; expired: boolean }

/** Storage for the flow. The Postgres version is in phone-verification-db.ts; tests use an in-memory one. */
export interface PhoneStore {
  /** Counts one hit in a fixed window and returns the new count (undefined if unusable). Bucket is already hashed. */
  hit(bucket: string, windowMs: number): Promise<number | undefined>;
  state(userId: string): Promise<{ emailVerified: boolean; phoneVerified: boolean }>;
  recordConsent(userId: string, version: string): Promise<void>;
  /** Replaces any live code for the user (old ones are consumed) with a new one. */
  createCode(userId: string, codeId: string, phoneE164: string, codeHash: string, expiresAt: string): Promise<void>;
  /** Atomically counts one guess on the user's newest unconsumed code. "locked" once the guess limit is used up. */
  takeGuess(userId: string, maxAttempts: number): Promise<LiveCode | "none" | "locked">;
  /** Single use: true for exactly one caller. */
  consume(codeId: string, userId: string): Promise<boolean>;
  markVerified(userId: string, phoneE164: string): Promise<void>;
  log(userId: string, event: PhoneEvent, ipHash: string | null): Promise<void>;
}

export interface PhoneDeps { store: PhoneStore; sms: SmsPort; secret: string | undefined; now?: () => number }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const OFF = fail("unavailable", "Mobile verification is not available yet.");
const WRONG = fail("invalid", "That code is not valid. Check it or ask for a new one.");

/** Counts every bucket (a refused attempt still counts) and reports whether all were within their limit. */
async function withinAll(d: PhoneDeps, keys: [string, number][], windowMs: number): Promise<boolean> {
  let ok = true;
  for (const [key, limit] of keys) {
    if (!withinLimit(await d.store.hit(sha256Hex(key), windowMs), limit)) ok = false;
  }
  return ok;
}

/** Sends a code. Needs the consent box ticked (recorded before the SMS), a configured SMS port and secret. */
export async function sendPhoneCode(d: PhoneDeps, userId: string, ip: string, input: unknown): Promise<Result<{ expiresInMinutes: number }>> {
  if (!d.sms.configured || !secretUsable(d.secret)) return OFF;
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (b["consent"] !== true) return fail("invalid", "Please tick the box to agree to receive the text message.");
  const phone = normaliseAuMobile(b["phone"]);
  if (!phone) return fail("invalid", "Enter an Australian mobile number, for example 0400 000 000.");
  const s = await d.store.state(userId);
  if (!s.emailVerified) return fail("forbidden", "Verify your email first.");
  if (s.phoneVerified) return fail("conflict", "Your mobile number is already verified.");
  const ipHash = sha256Hex(`ip:${ip}`);
  const inLimit = await withinAll(d, [
    [`sms-send:user:${userId}`, SMS_SEND_RATE.perUser], [`sms-send:ip:${ip}`, SMS_SEND_RATE.perIp], [`sms-send:phone:${phone}`, SMS_SEND_RATE.perPhone]
  ], SMS_SEND_RATE.windowMs);
  if (!inLimit) {
    await d.store.log(userId, "rate_limited", ipHash);
    return fail("rate_limited", "Too many codes requested. Try again later.");
  }
  await d.store.recordConsent(userId, SMS_CONSENT_VERSION);
  const codeId = randomUUID();
  const code = newCode();
  const expiresAt = new Date((d.now ?? Date.now)() + CODE_TTL_MS).toISOString();
  await d.store.createCode(userId, codeId, phone, hashCode(d.secret, userId, codeId, code), expiresAt);
  try {
    await d.sms.sendCode(phone, code);
  } catch {
    await d.store.consume(codeId, userId);
    await d.store.log(userId, "send_failed", ipHash);
    return fail("unavailable", "We could not send the text message. Try again later.");
  }
  await d.store.log(userId, "code_sent", ipHash);
  return { ok: true, value: { expiresInMinutes: CODE_TTL_MS / 60000 } };
}

/** Checks a code. phone_verified_at is set only by a correct, unexpired, unused code within the guess limit. */
export async function verifyPhoneCode(d: PhoneDeps, userId: string, ip: string, input: unknown): Promise<Result<{ verified: true }>> {
  if (!d.sms.configured || !secretUsable(d.secret)) return OFF;
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>)["code"] : undefined;
  if (typeof raw !== "string" || !/^\d{6}$/.test(raw)) return fail("invalid", "Enter the 6-digit code.");
  const ipHash = sha256Hex(`ip:${ip}`);
  const inLimit = await withinAll(d, [[`sms-verify:user:${userId}`, SMS_VERIFY_RATE.perUser], [`sms-verify:ip:${ip}`, SMS_VERIFY_RATE.perIp]], SMS_VERIFY_RATE.windowMs);
  if (!inLimit) {
    await d.store.log(userId, "rate_limited", ipHash);
    return fail("rate_limited", "Too many attempts. Try again later.");
  }
  const live = await d.store.takeGuess(userId, MAX_CODE_ATTEMPTS);
  if (live === "locked") {
    await d.store.log(userId, "code_locked", ipHash);
    return fail("rate_limited", "Too many wrong codes. Ask for a new code.");
  }
  if (live === "none") return WRONG;
  if (live.expired) {
    await d.store.log(userId, "code_expired", ipHash);
    return fail("invalid", "That code has expired. Ask for a new one.");
  }
  if (!hashesEqual(hashCode(d.secret, userId, live.id, raw), live.codeHash)) {
    await d.store.log(userId, "code_wrong", ipHash);
    return WRONG;
  }
  if (!(await d.store.consume(live.id, userId))) return WRONG;
  await d.store.markVerified(userId, live.phoneE164);
  await d.store.log(userId, "verified", ipHash);
  return { ok: true, value: { verified: true } };
}
