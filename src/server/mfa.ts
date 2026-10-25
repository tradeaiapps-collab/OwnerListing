import { randomUUID } from "node:crypto";
import type { SmsPort } from "../adapters/sms";
import type { Failure, Result } from "../domain/listing-service";
import {
  MAX_SMS_CODE_ATTEMPTS, MFA_SMS_RATE, MFA_VERIFY_RATE, SMS_CODE_TTL_MS,
  mfaHash, mfaKeyUsable, newRecoveryCodes, newTotpSecret, normaliseRecoveryCode, otpauthUri, stepUpSatisfied, verifyTotp, type MfaMethod
} from "../domain/mfa";
import { sealOfferToken, openOfferToken } from "../domain/offer-link-crypto";
import { hashesEqual, newCode, normaliseAuMobile } from "../domain/phone-verification";
import { withinLimit } from "../domain/rate-limit";
import type { SessionState } from "./auth/actor";

export type MfaEvent =
  | "setup_started" | "enrolled" | "verified" | "code_wrong" | "code_expired" | "code_locked"
  | "code_sent" | "send_failed" | "recovery_used" | "recovery_regenerated" | "factor_removed" | "rate_limited";

export interface MfaFactor {
  id: string;
  kind: MfaMethod;
  confirmed: boolean;
  /** totp only. */
  secretSealed?: string;
  /** sms only. */
  phoneE164?: string;
  lastUsedStep: number;
  createdAt: string;
}

export interface LiveSmsCode { id: string; codeHash: string; expired: boolean }

/** Storage for the MFA flows. The Postgres version is in mfa-db.ts; tests use an in-memory one. */
export interface MfaStore {
  /** Counts one hit in a fixed window and returns the new count (undefined if unusable). Bucket is already hashed. */
  hit(bucket: string, windowMs: number): Promise<number | undefined>;
  /** The user's methods that are not revoked, confirmed or still being set up. */
  factors(userId: string): Promise<MfaFactor[]>;
  /** The name shown in the authenticator app (the account's email). */
  accountLabel(userId: string): Promise<string>;
  /** Starts setting up a method. Any unconfirmed set-up of the same kind is revoked first. */
  startFactor(userId: string, kind: MfaMethod, value: { secretSealed: string } | { phoneE164: string }): Promise<string>;
  /** Single use: true for exactly one caller, and only for an unconfirmed, unrevoked factor of this user. */
  confirmFactor(factorId: string, userId: string): Promise<boolean>;
  /** Atomically raises the factor's last accepted TOTP step. False if the step was already used (a replay). */
  useTotpStep(factorId: string, userId: string, step: number): Promise<boolean>;
  markUsed(factorId: string, userId: string): Promise<void>;
  revokeFactor(factorId: string, userId: string): Promise<boolean>;
  /** Replaces any live SMS code for the user with a new one. */
  createSmsCode(userId: string, factorId: string, codeId: string, codeHash: string, expiresAt: string): Promise<void>;
  /** Atomically counts one guess on the newest unconsumed code for this factor. "locked" once the guess limit is used up. */
  takeSmsGuess(userId: string, factorId: string, maxAttempts: number): Promise<LiveSmsCode | "none" | "locked">;
  consumeSmsCode(codeId: string, userId: string): Promise<boolean>;
  /** Retires the old set and stores the new hashes. */
  replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void>;
  /** Single use: true for exactly one caller. */
  useRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
  recoveryCodesLeft(userId: string): Promise<number>;
  recordSmsConsent(userId: string, version: string): Promise<void>;
  log(userId: string, event: MfaEvent, method: MfaMethod | "recovery" | null, ipHash: string | null): Promise<void>;
}

export interface MfaDeps {
  store: MfaStore;
  sms: SmsPort;
  /** MFA_SECRET_KEY. Unusable = every MFA flow answers "unavailable" (fails closed). */
  key: string | undefined;
  issuer: string;
  now?: () => number;
}

export const MFA_SMS_CONSENT_VERSION = "mfa-2026-10-25";
export const mfaSmsConsentText = (brandName: string) =>
  `I agree that ${brandName} may send text messages with sign-in codes to this mobile number. It is used only to protect my sign-in.`;

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const OFF = fail("unavailable", "Two-step sign-in is not available yet. Try again later.");
const SMS_OFF = fail("unavailable", "Text message codes are not available yet. Use an authenticator app.");
const WRONG = fail("invalid", "That code is not valid. Check it and try again.");
const totpAad = (userId: string) => `mfa-totp:${userId}`;
const nowMs = (d: MfaDeps) => (d.now ?? Date.now)();
const body = (input: unknown): Record<string, unknown> => (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

/** Counts every bucket (a refused attempt still counts) and reports whether all were within their limit. */
async function withinAll(d: MfaDeps & { key: string }, keys: [string, number][], windowMs: number): Promise<boolean> {
  let ok = true;
  for (const [k, limit] of keys) {
    if (!withinLimit(await d.store.hit(mfaHash(d.key, "bucket", k), windowMs), limit)) ok = false;
  }
  return ok;
}

const ipHashOf = (key: string, ip: string) => mfaHash(key, "ip", ip);
const phoneHint = (e164: string) => `•••• ${e164.slice(-3)}`;

export interface MfaStatus {
  required: boolean;
  enrolled: boolean;
  verified: boolean;
  /** Passed in the last 15 minutes, so sensitive actions go ahead without another check. */
  recent: boolean;
  available: { totp: boolean; sms: boolean };
  methods: { id: string; kind: MfaMethod; label: string; addedAt: string }[];
  recoveryCodesLeft: number;
  smsConsentText: string;
}

/** What the MFA page shows. Methods still being set up are left out. Never returns a secret or a full phone number. */
export async function mfaStatus(d: MfaDeps, s: SessionState, brandName: string): Promise<MfaStatus> {
  const keyOk = mfaKeyUsable(d.key);
  const factors = (await d.store.factors(s.actor.userId)).filter(f => f.confirmed);
  return {
    required: s.mfa.required,
    enrolled: s.mfa.enrolled,
    verified: s.mfa.satisfied,
    recent: s.mfa.satisfied && stepUpSatisfied(s.payload.mfa, Math.floor(nowMs(d) / 1000)),
    available: { totp: keyOk, sms: keyOk && d.sms.configured },
    methods: factors.map(f => ({ id: f.id, kind: f.kind, label: f.kind === "sms" ? `Text message to ${phoneHint(f.phoneE164 ?? "")}` : "Authenticator app", addedAt: f.createdAt })),
    recoveryCodesLeft: factors.length ? await d.store.recoveryCodesLeft(s.actor.userId) : 0,
    smsConsentText: mfaSmsConsentText(brandName)
  };
}

/** Starts authenticator set-up. Returns the secret once, for the app; it is stored sealed and never shown again. */
export async function startTotp(d: MfaDeps, userId: string): Promise<Result<{ secret: string; otpauthUri: string }>> {
  if (!mfaKeyUsable(d.key)) return OFF;
  if ((await d.store.factors(userId)).some(f => f.kind === "totp" && f.confirmed)) {
    return fail("conflict", "An authenticator app is already set up. Remove it first to set up a new one.");
  }
  const secret = newTotpSecret();
  await d.store.startFactor(userId, "totp", { secretSealed: await sealOfferToken(secret, d.key, totpAad(userId)) });
  await d.store.log(userId, "setup_started", "totp", null);
  return { ok: true, value: { secret, otpauthUri: otpauthUri(d.issuer, await d.store.accountLabel(userId), secret) } };
}

/** Starts text-message set-up: needs the consent box ticked (recorded before the SMS) and a configured SMS port. */
export async function startSms(d: MfaDeps, userId: string, ip: string, input: unknown): Promise<Result<{ expiresInMinutes: number }>> {
  if (!mfaKeyUsable(d.key)) return OFF;
  if (!d.sms.configured) return SMS_OFF;
  const b = body(input);
  if (b["consent"] !== true) return fail("invalid", "Please tick the box to agree to receive sign-in codes by text message.");
  const phone = normaliseAuMobile(b["phone"]);
  if (!phone) return fail("invalid", "Enter an Australian mobile number, for example 0400 000 000.");
  if ((await d.store.factors(userId)).some(f => f.kind === "sms" && f.confirmed)) {
    return fail("conflict", "Text message codes are already set up. Remove them first to use a different number.");
  }
  const factorId = await d.store.startFactor(userId, "sms", { phoneE164: phone });
  await d.store.recordSmsConsent(userId, MFA_SMS_CONSENT_VERSION);
  await d.store.log(userId, "setup_started", "sms", ipHashOf(d.key, ip));
  return sendCodeTo(d as MfaDeps & { key: string }, userId, ip, factorId, phone);
}

/** Texts a sign-in code to the user's confirmed number. */
export async function sendSignInSms(d: MfaDeps, userId: string, ip: string): Promise<Result<{ expiresInMinutes: number }>> {
  if (!mfaKeyUsable(d.key)) return OFF;
  if (!d.sms.configured) return SMS_OFF;
  const f = (await d.store.factors(userId)).find(x => x.kind === "sms" && x.confirmed);
  if (!f?.phoneE164) return fail("invalid", "Text message codes are not set up for this account.");
  return sendCodeTo(d as MfaDeps & { key: string }, userId, ip, f.id, f.phoneE164);
}

async function sendCodeTo(d: MfaDeps & { key: string }, userId: string, ip: string, factorId: string, phone: string): Promise<Result<{ expiresInMinutes: number }>> {
  const ipHash = ipHashOf(d.key, ip);
  const inLimit = await withinAll(d, [
    [`mfa-sms:user:${userId}`, MFA_SMS_RATE.perUser], [`mfa-sms:ip:${ip}`, MFA_SMS_RATE.perIp], [`mfa-sms:phone:${phone}`, MFA_SMS_RATE.perPhone]
  ], MFA_SMS_RATE.windowMs);
  if (!inLimit) {
    await d.store.log(userId, "rate_limited", "sms", ipHash);
    return fail("rate_limited", "Too many codes requested. Try again later.");
  }
  const codeId = randomUUID();
  const code = newCode();
  await d.store.createSmsCode(userId, factorId, codeId, mfaHash(d.key, `sms:${userId}:${codeId}`, code), new Date(nowMs(d) + SMS_CODE_TTL_MS).toISOString());
  try {
    await d.sms.sendCode(phone, code);
  } catch {
    await d.store.consumeSmsCode(codeId, userId);
    await d.store.log(userId, "send_failed", "sms", ipHash);
    return fail("unavailable", "We could not send the text message. Try again later.");
  }
  await d.store.log(userId, "code_sent", "sms", ipHash);
  return { ok: true, value: { expiresInMinutes: SMS_CODE_TTL_MS / 60000 } };
}

/** Rate limit shared by every code check (set-up and sign-in), so switching method does not buy more guesses. */
async function verifyAllowed(d: MfaDeps & { key: string }, userId: string, ip: string): Promise<boolean> {
  const ok = await withinAll(d, [[`mfa-verify:user:${userId}`, MFA_VERIFY_RATE.perUser], [`mfa-verify:ip:${ip}`, MFA_VERIFY_RATE.perIp]], MFA_VERIFY_RATE.windowMs);
  if (!ok) await d.store.log(userId, "rate_limited", null, ipHashOf(d.key, ip));
  return ok;
}

async function checkTotp(d: MfaDeps & { key: string }, userId: string, f: MfaFactor, code: string): Promise<boolean> {
  const secret = f.secretSealed ? await openOfferToken(f.secretSealed, d.key, totpAad(userId)) : undefined;
  if (!secret) return false;
  const step = verifyTotp(secret, code, Math.floor(nowMs(d) / 1000), f.lastUsedStep);
  return step !== undefined && (await d.store.useTotpStep(f.id, userId, step));
}

async function checkSms(d: MfaDeps & { key: string }, userId: string, f: MfaFactor, code: string, ipHash: string): Promise<Result<true>> {
  const live = await d.store.takeSmsGuess(userId, f.id, MAX_SMS_CODE_ATTEMPTS);
  if (live === "locked") {
    await d.store.log(userId, "code_locked", "sms", ipHash);
    return fail("rate_limited", "Too many wrong codes. Ask for a new code.");
  }
  if (live === "none") return WRONG;
  if (live.expired) {
    await d.store.log(userId, "code_expired", "sms", ipHash);
    return fail("invalid", "That code has expired. Ask for a new one.");
  }
  if (!hashesEqual(mfaHash(d.key, `sms:${userId}:${live.id}`, code), live.codeHash) || !(await d.store.consumeSmsCode(live.id, userId))) return WRONG;
  return { ok: true, value: true };
}

const sixDigits = (raw: unknown): string | undefined => (typeof raw === "string" && /^\d{6}$/.test(raw.replace(/\s/g, "")) ? raw.replace(/\s/g, "") : undefined);

/**
 * Finishes setting up a method with a correct code. The first method also issues 10 recovery codes, shown once.
 * A confirmed method counts as passing MFA for this session (the caller marks the session).
 */
export async function confirmFactor(d: MfaDeps, userId: string, ip: string, kind: MfaMethod, input: unknown): Promise<Result<{ recoveryCodes?: string[] }>> {
  if (!mfaKeyUsable(d.key)) return OFF;
  const k = d as MfaDeps & { key: string };
  const code = sixDigits(body(input)["code"]);
  if (!code) return fail("invalid", "Enter the 6-digit code.");
  if (!(await verifyAllowed(k, userId, ip))) return fail("rate_limited", "Too many attempts. Try again later.");
  const all = await d.store.factors(userId);
  const f = all.find(x => x.kind === kind && !x.confirmed);
  if (!f) return fail("invalid", "Start the set-up again.");
  const ipHash = ipHashOf(k.key, ip);
  if (kind === "totp") {
    if (!(await checkTotp(k, userId, f, code))) {
      await d.store.log(userId, "code_wrong", "totp", ipHash);
      return WRONG;
    }
  } else {
    const r = await checkSms(k, userId, f, code, ipHash);
    if (!r.ok) {
      if (r === WRONG) await d.store.log(userId, "code_wrong", "sms", ipHash);
      return r;
    }
  }
  if (!(await d.store.confirmFactor(f.id, userId))) return fail("conflict", "Start the set-up again.");
  await d.store.log(userId, "enrolled", kind, ipHash);
  if (all.some(x => x.confirmed)) return { ok: true, value: {} };
  return { ok: true, value: { recoveryCodes: await issueRecoveryCodes(k, userId) } };
}

async function issueRecoveryCodes(d: MfaDeps & { key: string }, userId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  await d.store.replaceRecoveryCodes(userId, codes.map(c => mfaHash(d.key, `recovery:${userId}`, normaliseRecoveryCode(c)!)));
  return codes;
}

/** The sign-in check: an authenticator code, a texted code, or a recovery code (each recovery code works once). */
export async function verifySecondFactor(d: MfaDeps, userId: string, ip: string, input: unknown): Promise<Result<{ method: MfaMethod | "recovery"; recoveryCodesLeft?: number }>> {
  if (!mfaKeyUsable(d.key)) return OFF;
  const k = d as MfaDeps & { key: string };
  const b = body(input);
  const method = b["method"];
  if (method !== "totp" && method !== "sms" && method !== "recovery") return fail("invalid", "Choose how you want to confirm it's you.");
  const ipHash = ipHashOf(k.key, ip);
  if (method === "recovery") {
    const code = normaliseRecoveryCode(b["code"]);
    if (!code) return fail("invalid", "Enter one of your recovery codes, for example abcd-efgh-ij.");
    if (!(await verifyAllowed(k, userId, ip))) return fail("rate_limited", "Too many attempts. Try again later.");
    if (!(await d.store.factors(userId)).some(f => f.confirmed) || !(await d.store.useRecoveryCode(userId, mfaHash(k.key, `recovery:${userId}`, code)))) {
      await d.store.log(userId, "code_wrong", "recovery", ipHash);
      return fail("invalid", "That recovery code is not valid or has already been used.");
    }
    await d.store.log(userId, "recovery_used", "recovery", ipHash);
    return { ok: true, value: { method, recoveryCodesLeft: await d.store.recoveryCodesLeft(userId) } };
  }
  const code = sixDigits(b["code"]);
  if (!code) return fail("invalid", "Enter the 6-digit code.");
  if (!(await verifyAllowed(k, userId, ip))) return fail("rate_limited", "Too many attempts. Try again later.");
  const f = (await d.store.factors(userId)).find(x => x.kind === method && x.confirmed);
  if (!f) return fail("invalid", method === "sms" ? "Text message codes are not set up for this account." : "An authenticator app is not set up for this account.");
  if (method === "totp") {
    if (!(await checkTotp(k, userId, f, code))) {
      await d.store.log(userId, "code_wrong", "totp", ipHash);
      return WRONG;
    }
  } else {
    const r = await checkSms(k, userId, f, code, ipHash);
    if (!r.ok) {
      if (r === WRONG) await d.store.log(userId, "code_wrong", "sms", ipHash);
      return r;
    }
  }
  await d.store.markUsed(f.id, userId);
  await d.store.log(userId, "verified", method, ipHash);
  return { ok: true, value: { method } };
}

/**
 * Removes a method. The caller requires a recent check first. Owners and agents must keep at least one method. Removing a method
 * ends every other session that passed MFA before now (the caller re-marks this one).
 */
export async function removeFactor(d: MfaDeps, s: SessionState, factorId: unknown): Promise<Result<{ removed: true }>> {
  if (!mfaKeyUsable(d.key)) return OFF;
  const userId = s.actor.userId;
  const confirmed = (await d.store.factors(userId)).filter(f => f.confirmed);
  const f = confirmed.find(x => x.id === factorId);
  if (!f) return fail("not_found", "That sign-in method was not found.");
  if (confirmed.length === 1 && (s.actor.userType === "owner" || s.actor.userType === "agent")) {
    return fail("conflict", "Owner and agent accounts must keep one sign-in method. Add another before removing this one.");
  }
  if (!(await d.store.revokeFactor(f.id, userId))) return fail("not_found", "That sign-in method was not found.");
  if (confirmed.length === 1) await d.store.replaceRecoveryCodes(userId, []);
  await d.store.log(userId, "factor_removed", f.kind, null);
  return { ok: true, value: { removed: true } };
}

/** A fresh set of 10 recovery codes; the old set stops working. The caller requires a recent check first. */
export async function regenerateRecoveryCodes(d: MfaDeps, userId: string): Promise<Result<{ recoveryCodes: string[] }>> {
  if (!mfaKeyUsable(d.key)) return OFF;
  if (!(await d.store.factors(userId)).some(f => f.confirmed)) return fail("invalid", "Set up a sign-in method first.");
  const codes = await issueRecoveryCodes(d as MfaDeps & { key: string }, userId);
  await d.store.log(userId, "recovery_regenerated", "recovery", null);
  return { ok: true, value: { recoveryCodes: codes } };
}
