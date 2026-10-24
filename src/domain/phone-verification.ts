import type { AuditEvent } from "./audit";
import { fail, type Actor, type Result } from "./listing-service";

export const CODE_TTL_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const MAX_SENDS_PER_HOUR = 3;

export interface PhoneChallenge {
  id: string;
  userId: string;
  phoneE164: string;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  createdAt: string;
  consumedAt?: string;
}

export interface PhoneRepository {
  insertChallenge(c: PhoneChallenge): Promise<void>;
  /** The newest challenge for the user that has not been used. */
  latestOpen(userId: string): Promise<PhoneChallenge | undefined>;
  sendsSince(userId: string, phoneE164: string, sinceIso: string): Promise<{ byUser: number; byPhone: number }>;
  /** Adds one attempt and returns the new count, in one atomic step. */
  bumpAttempts(id: string): Promise<number>;
  consume(id: string, now: string): Promise<void>;
  /** Records the verified number. False if another account already holds it. */
  markVerified(userId: string, phoneE164: string, now: string): Promise<boolean>;
}

/** Sends a text message. Absent means mobile verification is not set up, so it stays blocked (fail closed). */
export interface SmsPort { send(toE164: string, text: string): Promise<void> }

export interface PhoneDeps {
  phones: PhoneRepository;
  sms: SmsPort | undefined;
  /** Keyed hash of a code, bound to the challenge id. */
  hashCode: (challengeId: string, code: string) => string;
  /** A six digit code from a secure random source. */
  newCode: () => string;
  appendAudit: (e: AuditEvent) => Promise<void>;
  now: () => string;
  newId: () => string;
}

/** Accepts Australian mobiles written as 04xx xxx xxx, +61 4xx xxx xxx or 614xxxxxxxx. Returns +614xxxxxxxx or null. */
export function parseAuMobile(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const d = input.replace(/[\s()-]/g, "");
  const m = /^(?:\+?61|0)(4\d{8})$/.exec(d);
  return m ? `+61${m[1]}` : null;
}

export async function startPhoneVerification(deps: PhoneDeps, actor: Actor, phoneInput: unknown): Promise<Result<{ expiresAt: string }>> {
  const phone = parseAuMobile(phoneInput);
  if (!phone) return fail("invalid", "Enter an Australian mobile number, for example 0412 345 678.");
  if (!deps.sms) return fail("unavailable", "Mobile verification is not available yet.");

  const now = deps.now();
  const since = new Date(new Date(now).getTime() - 60 * 60_000).toISOString();
  const sent = await deps.phones.sendsSince(actor.userId, phone, since);
  if (sent.byUser >= MAX_SENDS_PER_HOUR || sent.byPhone >= MAX_SENDS_PER_HOUR) {
    return fail("rate_limited", "Too many codes requested. Try again in an hour.");
  }

  const id = deps.newId();
  const code = deps.newCode();
  const expiresAt = new Date(new Date(now).getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
  await deps.phones.insertChallenge({
    id, userId: actor.userId, phoneE164: phone, codeHash: deps.hashCode(id, code), expiresAt, attempts: 0, createdAt: now
  });
  await deps.sms.send(phone, `Your OwnerListing code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. Do not share it.`);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "user", aggregateId: actor.userId, eventType: "phone.code_sent",
    correlationId: deps.newId(), payload: {}
  });
  return { ok: true, value: { expiresAt } };
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function confirmPhoneVerification(deps: PhoneDeps, actor: Actor, codeInput: unknown): Promise<Result<{ phoneVerified: true }>> {
  const code = typeof codeInput === "string" ? codeInput.trim() : "";
  if (!/^\d{6}$/.test(code)) return fail("invalid", "Enter the 6 digit code.");

  const now = deps.now();
  const c = await deps.phones.latestOpen(actor.userId);
  if (!c || c.expiresAt <= now) return fail("conflict", "That code has expired. Request a new one.");
  // Count the attempt first so parallel guesses cannot exceed the limit.
  const attempts = await deps.phones.bumpAttempts(c.id);
  if (attempts > MAX_ATTEMPTS) return fail("rate_limited", "Too many wrong codes. Request a new one.");
  if (!sameHash(c.codeHash, deps.hashCode(c.id, code))) return fail("invalid", "That code is not correct.");

  await deps.phones.consume(c.id, now);
  if (!(await deps.phones.markVerified(actor.userId, c.phoneE164, now))) {
    return fail("conflict", "That number is already verified on another account.");
  }
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "user", aggregateId: actor.userId, eventType: "phone.verified",
    correlationId: deps.newId(), payload: {}
  });
  return { ok: true, value: { phoneVerified: true } };
}

export function createInMemoryPhoneRepository(): PhoneRepository & { verified: Map<string, string> } {
  const rows: PhoneChallenge[] = [];
  const verified = new Map<string, string>();
  return {
    verified,
    async insertChallenge(c) { rows.push(c); },
    async latestOpen(userId) {
      return rows.filter(r => r.userId === userId && r.consumedAt === undefined).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    },
    async sendsSince(userId, phone, since) {
      const recent = rows.filter(r => r.createdAt >= since);
      return { byUser: recent.filter(r => r.userId === userId).length, byPhone: recent.filter(r => r.phoneE164 === phone).length };
    },
    async bumpAttempts(id) {
      const r = rows.find(x => x.id === id);
      if (!r) return Number.MAX_SAFE_INTEGER;
      r.attempts += 1;
      return r.attempts;
    },
    async consume(id, now) {
      const r = rows.find(x => x.id === id);
      if (r) r.consumedAt = now;
    },
    async markVerified(userId, phone) {
      for (const [u, p] of verified) if (p === phone && u !== userId) return false;
      verified.set(userId, phone);
      return true;
    }
  };
}
