import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SmsPort } from "../src/adapters/sms";
import {
  STEP_UP_SECONDS, base32Decode, base32Encode, hotp, mfaClaimValid, mfaKeyUsable, mfaRequired, newRecoveryCodes,
  normaliseRecoveryCode, otpauthUri, stepUpSatisfied, totpStep, verifyTotp
} from "../src/domain/mfa";
import { actorFromRequestChecked, sessionFromRequestChecked, type SessionState } from "../src/server/auth/actor";
import { SESSION_COOKIE, signSession, verifySession } from "../src/server/auth/session";
import type { Queryable } from "../src/server/db";
import {
  confirmFactor, mfaStatus, regenerateRecoveryCodes, removeFactor, sendSignInSms, startSms, startTotp, verifySecondFactor, type MfaDeps
} from "../src/server/mfa";
import { createPgMfaStore, mfaEnrolledPg } from "../src/server/mfa-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC test vectors", () => {
    const key = base32Decode(RFC_SECRET)!;
    expect(hotp(key, totpStep(59), 8)).toBe("94287082");
    expect(hotp(key, totpStep(1111111109), 8)).toBe("07081804");
    expect(hotp(key, totpStep(1234567890), 8)).toBe("89005924");
    expect(hotp(key, totpStep(2000000000), 8)).toBe("69279037");
    expect(hotp(key, totpStep(1234567890))).toBe("005924");
  });
  it("round-trips base32 and refuses other characters", () => {
    const b = randomBytes(20);
    expect(Buffer.from(base32Decode(base32Encode(b))!)).toEqual(b);
    expect(base32Decode("abcd efgh====")).toEqual(base32Decode("ABCDEFGH"));
    expect(base32Decode("AB1C")).toBeUndefined();
  });
  it("accepts one step of clock drift either way, not two", () => {
    const t = 1_800_000_000;
    const key = base32Decode(RFC_SECRET)!;
    const at = (s: number) => hotp(key, totpStep(t) + s);
    expect(verifyTotp(RFC_SECRET, at(0), t)).toBe(totpStep(t));
    expect(verifyTotp(RFC_SECRET, at(-1), t)).toBe(totpStep(t) - 1);
    expect(verifyTotp(RFC_SECRET, at(1), t)).toBe(totpStep(t) + 1);
    expect(verifyTotp(RFC_SECRET, at(2), t)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, at(-2), t)).toBeUndefined();
  });
  it("never accepts a step at or before the last one used (no replay)", () => {
    const t = 1_800_000_000;
    const code = hotp(base32Decode(RFC_SECRET)!, totpStep(t));
    expect(verifyTotp(RFC_SECRET, code, t, totpStep(t) - 1)).toBe(totpStep(t));
    expect(verifyTotp(RFC_SECRET, code, t, totpStep(t))).toBeUndefined();
  });
  it("refuses malformed codes and short secrets", () => {
    expect(verifyTotp(RFC_SECRET, "12345", 0)).toBeUndefined();
    expect(verifyTotp(RFC_SECRET, "12345a", 0)).toBeUndefined();
    expect(verifyTotp("AAAA", "000000", 0)).toBeUndefined();
  });
  it("builds an otpauth address an authenticator app can read", () => {
    const u = new URL(otpauthUri("OwnerListing", "a@b.test", RFC_SECRET));
    expect(u.protocol).toBe("otpauth:");
    expect(u.host).toBe("totp");
    expect(u.pathname).toBe("/OwnerListing:a%40b.test");
    expect(u.searchParams.get("secret")).toBe(RFC_SECRET);
    expect(u.searchParams.get("digits")).toBe("6");
  });
});

describe("MFA rules", () => {
  it("is required for owners and agents, and for anyone who enrolled", () => {
    expect(mfaRequired("owner", false)).toBe(true);
    expect(mfaRequired("agent", false)).toBe(true);
    expect(mfaRequired("buyer", false)).toBe(false);
    expect(mfaRequired("vendor", false)).toBe(false);
    expect(mfaRequired("buyer", true)).toBe(true);
  });
  it("ends a session's MFA claim when a method was removed after it", () => {
    expect(mfaClaimValid(undefined, undefined)).toBe(false);
    expect(mfaClaimValid(100, undefined)).toBe(true);
    expect(mfaClaimValid(100, 100)).toBe(true);
    expect(mfaClaimValid(99, 100)).toBe(false);
  });
  it("lets a sensitive action through only within 15 minutes of a check", () => {
    const now = 1_800_000_000;
    expect(stepUpSatisfied(now - STEP_UP_SECONDS, now)).toBe(true);
    expect(stepUpSatisfied(now - STEP_UP_SECONDS - 1, now)).toBe(false);
    expect(stepUpSatisfied(undefined, now)).toBe(false);
    expect(stepUpSatisfied(now + 3600, now)).toBe(false);
  });
  it("makes ten distinct recovery codes and reads them back however they are typed", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/);
    expect(normaliseRecoveryCode(" ABCD-efgh-23 ")).toBe("abcdefgh23");
    expect(normaliseRecoveryCode("abcd-efgh-2")).toBeUndefined();
    expect(normaliseRecoveryCode(12)).toBeUndefined();
  });
  it("accepts only a 32-byte base64 key", () => {
    expect(mfaKeyUsable(randomBytes(32).toString("base64"))).toBe(true);
    expect(mfaKeyUsable(randomBytes(16).toString("base64"))).toBe(false);
    expect(mfaKeyUsable(undefined)).toBe(false);
  });
  it("keeps the MFA claim through signing and refuses a non-number claim", () => {
    const secret = "s".repeat(40);
    expect(verifySession(signSession({ uid: "u", ut: "owner", exp: 200, mfa: 150 }, secret), secret, 100)?.mfa).toBe(150);
    expect(verifySession(signSession({ uid: "u", ut: "owner", exp: 200 }, secret), secret, 100)).toEqual({ uid: "u", ut: "owner", exp: 200 });
    const body = Buffer.from(JSON.stringify({ uid: "u", ut: "owner", exp: 200, mfa: "yes" })).toString("base64url");
    const forged = signSession({ uid: "u", ut: "owner", exp: 200 }, secret).replace(/^[^.]+/, body);
    expect(verifySession(forged, secret, 100)).toBeNull();
  });
});

describe("the session counts as signed in only after the second step", () => {
  const secret = "s".repeat(40);
  const now = 1_800_000_000;
  const uid = "11111111-1111-4111-8111-111111111111";
  const req = (ut: "owner" | "agent" | "buyer", mfa?: number) =>
    new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid, ut, exp: now + 100, ...(mfa !== undefined ? { mfa } : {}) }, secret)}` } });
  const db = (ut: string, enrolled: boolean, revokedAt: number | null = null): Queryable => ({
    async query() { return { rows: [{ id: uid, user_type: ut, mfa_enrolled: enrolled, mfa_revoked_at: revokedAt === null ? null : String(revokedAt) }] }; }
  });

  it("denies an owner or agent who has not passed MFA, enrolled or not", async () => {
    for (const ut of ["owner", "agent"] as const) {
      expect(await actorFromRequestChecked(db(ut, false), req(ut), secret, now)).toBeNull();
      expect(await actorFromRequestChecked(db(ut, true), req(ut), secret, now)).toBeNull();
      expect(await actorFromRequestChecked(db(ut, true), req(ut, now - 5), secret, now)).toEqual({ userId: uid, userType: ut });
    }
  });
  it("lets a buyer without MFA in, but holds a buyer who enrolled until they pass it", async () => {
    expect(await actorFromRequestChecked(db("buyer", false), req("buyer"), secret, now)).toEqual({ userId: uid, userType: "buyer" });
    expect(await actorFromRequestChecked(db("buyer", true), req("buyer"), secret, now)).toBeNull();
    expect(await actorFromRequestChecked(db("buyer", true), req("buyer", now - 5), secret, now)).not.toBeNull();
  });
  it("ends a session that passed MFA before a method was removed or reset", async () => {
    expect(await actorFromRequestChecked(db("owner", true, now - 1), req("owner", now - 5), secret, now)).toBeNull();
    expect(await actorFromRequestChecked(db("owner", true, now - 10), req("owner", now - 5), secret, now)).not.toBeNull();
  });
  it("still reports the pending session to the MFA routes", async () => {
    const s = await sessionFromRequestChecked(db("owner", false), req("owner"), secret, now);
    expect(s?.mfa).toEqual({ required: true, enrolled: false, satisfied: false });
    expect(s?.actor).toEqual({ userId: uid, userType: "owner" });
  });
});

// ---- the flows, end to end on a real Postgres ----
describe.skipIf(!DATABASE_URL)("MFA flows on Postgres", () => {
  let t: TestDb;
  let clock: number;
  let sent: { to: string; code: string }[];
  let smsUp: boolean;
  const KEY = randomBytes(32).toString("base64");
  // A fresh client address per test, so the per-IP limits of one test never spill into the next.
  let IP = "";
  const sms: SmsPort = {
    get configured() { return true; },
    async sendCode(to, code) { if (!smsUp) throw new Error("down"); sent.push({ to, code }); }
  };
  const deps = (o: Partial<MfaDeps> = {}): MfaDeps => ({ store: createPgMfaStore(t.db), sms, key: KEY, issuer: "OwnerListing", now: () => clock, ...o });
  const totpNow = (secret: string, offset = 0) => hotp(base32Decode(secret)!, totpStep(Math.floor(clock / 1000)) + offset);
  const state = (userId: string, ut: "owner" | "buyer", enrolled: boolean): SessionState => ({
    actor: { userId, userType: ut }, payload: { uid: userId, ut, exp: 0, mfa: Math.floor(clock / 1000) }, mfa: { required: true, enrolled, satisfied: true }
  });
  const events = async (userId: string) => (await t.db.query("SELECT event FROM mfa_event_log WHERE user_id = $1 ORDER BY occurred_at, id", [userId])).rows.map(r => r["event"]);

  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => { await t.close(); });
  beforeEach(() => { clock = 1_800_000_000_000; sent = []; smsUp = true; IP = `203.0.113.${Math.floor(Math.random() * 250) + 1}-${randomBytes(4).toString("hex")}`; });

  it("sets up an authenticator app, stores the secret sealed and issues recovery codes once", async () => {
    const owner = await addUser(t.db, "owner");
    const s = await startTotp(deps(), owner);
    if (!s.ok) throw new Error(s.message);
    expect(s.value.otpauthUri).toContain(encodeURIComponent("@example.test"));
    const row = (await t.db.query("SELECT secret_sealed FROM mfa_factor WHERE user_id = $1", [owner])).rows[0]!;
    expect(String(row["secret_sealed"])).toMatch(/^v1\./);
    expect(String(row["secret_sealed"])).not.toContain(s.value.secret);
    expect((await confirmFactor(deps(), owner, IP, "totp", { code: "000000" })).ok).toBe(false);
    const ok = await confirmFactor(deps(), owner, IP, "totp", { code: totpNow(s.value.secret) });
    if (!ok.ok) throw new Error(ok.message);
    expect(ok.value.recoveryCodes).toHaveLength(10);
    expect(await mfaEnrolledPg(t.db, owner)).toBe(true);
    const hashes = (await t.db.query("SELECT code_hash FROM mfa_recovery_code WHERE user_id = $1", [owner])).rows.map(r => String(r["code_hash"]));
    expect(hashes).toHaveLength(10);
    for (const c of ok.value.recoveryCodes!) expect(hashes.join()).not.toContain(c.replace(/-/g, ""));
    expect((await startTotp(deps(), owner)).ok).toBe(false);
    expect(await events(owner)).toEqual(["setup_started", "code_wrong", "enrolled"]);
  });

  it("checks an authenticator code at sign-in and refuses the same code twice", async () => {
    const owner = await addUser(t.db, "owner");
    const s = await startTotp(deps(), owner);
    if (!s.ok) throw new Error(s.message);
    await confirmFactor(deps(), owner, IP, "totp", { code: totpNow(s.value.secret) });
    clock += 30_000;
    const code = totpNow(s.value.secret);
    expect(await verifySecondFactor(deps(), owner, IP, { method: "totp", code })).toEqual({ ok: true, value: { method: "totp" } });
    expect((await verifySecondFactor(deps(), owner, IP, { method: "totp", code })).ok).toBe(false);
    expect((await verifySecondFactor(deps(), owner, IP, { method: "sms", code })).ok).toBe(false);
    expect((await verifySecondFactor(deps(), owner, IP, { method: "magic", code })).ok).toBe(false);
  });

  it("uses each recovery code once, and a new set retires the old one", async () => {
    const owner = await addUser(t.db, "owner");
    const s = await startTotp(deps(), owner);
    if (!s.ok) throw new Error(s.message);
    const c = await confirmFactor(deps(), owner, IP, "totp", { code: totpNow(s.value.secret) });
    if (!c.ok) throw new Error(c.message);
    const [first, second] = c.value.recoveryCodes!;
    expect(await verifySecondFactor(deps(), owner, IP, { method: "recovery", code: first!.toUpperCase() })).toEqual({ ok: true, value: { method: "recovery", recoveryCodesLeft: 9 } });
    expect((await verifySecondFactor(deps(), owner, IP, { method: "recovery", code: first })).ok).toBe(false);
    const fresh = await regenerateRecoveryCodes(deps(), owner);
    if (!fresh.ok) throw new Error(fresh.message);
    expect((await verifySecondFactor(deps(), owner, IP, { method: "recovery", code: second })).ok).toBe(false);
    expect((await verifySecondFactor(deps(), owner, IP, { method: "recovery", code: fresh.value.recoveryCodes[0] })).ok).toBe(true);
  });

  it("sets up text-message codes with recorded consent and signs in with a texted code", async () => {
    const buyer = await addUser(t.db, "buyer");
    expect((await startSms(deps(), buyer, IP, { phone: "0400 000 001" })).ok).toBe(false);
    expect((await startSms(deps(), buyer, IP, { phone: "12345", consent: true })).ok).toBe(false);
    expect((await startSms(deps(), buyer, IP, { phone: "0400 000 001", consent: true })).ok).toBe(true);
    expect(sent).toEqual([{ to: "+61400000001", code: expect.stringMatching(/^\d{6}$/) }]);
    expect((await t.db.query("SELECT wording_version FROM phone_sms_consent WHERE user_id = $1", [buyer])).rows[0]?.["wording_version"]).toBe("mfa-2026-10-25");
    const c = await confirmFactor(deps(), buyer, IP, "sms", { code: sent[0]!.code });
    expect(c.ok && c.value.recoveryCodes?.length).toBe(10);
    expect((await sendSignInSms(deps(), buyer, IP)).ok).toBe(true);
    expect((await verifySecondFactor(deps(), buyer, IP, { method: "sms", code: sent[0]!.code })).ok).toBe(false);
    expect((await verifySecondFactor(deps(), buyer, IP, { method: "sms", code: sent[1]!.code })).ok).toBe(true);
    expect((await verifySecondFactor(deps(), buyer, IP, { method: "sms", code: sent[1]!.code })).ok).toBe(false);
  });

  it("expires texted codes after 10 minutes and locks a code after 5 wrong guesses", async () => {
    const buyer = await addUser(t.db, "buyer");
    await startSms(deps(), buyer, IP, { phone: "0400 000 002", consent: true });
    await confirmFactor(deps(), buyer, IP, "sms", { code: sent[0]!.code });
    await sendSignInSms(deps(), buyer, IP);
    await t.db.query("UPDATE mfa_sms_code SET expires_at = now() - interval '1 second' WHERE user_id = $1 AND consumed_at IS NULL", [buyer]);
    const expired = await verifySecondFactor(deps(), buyer, IP, { method: "sms", code: sent[1]!.code });
    expect(!expired.ok && expired.message).toMatch(/expired/);
    await sendSignInSms(deps(), buyer, IP);
    const wrong = sent[2]!.code === "111111" ? "222222" : "111111";
    for (let i = 0; i < 5; i++) await verifySecondFactor(deps(), buyer, IP, { method: "sms", code: wrong });
    const locked = await verifySecondFactor(deps(), buyer, IP, { method: "sms", code: sent[2]!.code });
    expect(!locked.ok && locked.code).toBe("rate_limited");
  });

  it("rate-limits code checks per user across methods", async () => {
    const owner = await addUser(t.db, "owner");
    const s = await startTotp(deps(), owner);
    if (!s.ok) throw new Error(s.message);
    await confirmFactor(deps(), owner, IP, "totp", { code: totpNow(s.value.secret) });
    for (let i = 0; i < 9; i++) await verifySecondFactor(deps(), owner, IP, { method: i % 2 ? "recovery" : "totp", code: i % 2 ? "aaaa-bbbb-cc" : "000000" });
    clock += 30_000;
    const r = await verifySecondFactor(deps(), owner, IP, { method: "totp", code: totpNow(s.value.secret) });
    expect(!r.ok && r.code).toBe("rate_limited");
    expect(await events(owner)).toContain("rate_limited");
  });

  it("does not leave a usable code when the text message fails to send", async () => {
    const buyer = await addUser(t.db, "buyer");
    smsUp = false;
    const r = await startSms(deps(), buyer, IP, { phone: "0400 000 003", consent: true });
    expect(!r.ok && r.code).toBe("unavailable");
    expect((await t.db.query("SELECT 1 FROM mfa_sms_code WHERE user_id = $1 AND consumed_at IS NULL", [buyer])).rows).toHaveLength(0);
  });

  it("keeps an owner's last method, and removing one ends older sessions", async () => {
    const owner = await addUser(t.db, "owner");
    const s = await startTotp(deps(), owner);
    if (!s.ok) throw new Error(s.message);
    await confirmFactor(deps(), owner, IP, "totp", { code: totpNow(s.value.secret) });
    const [totp] = await createPgMfaStore(t.db).factors(owner);
    const last = await removeFactor(deps(), state(owner, "owner", true), totp!.id);
    expect(!last.ok && last.code).toBe("conflict");
    await startSms(deps(), owner, IP, { phone: "0400 000 004", consent: true });
    await confirmFactor(deps(), owner, IP, "sms", { code: sent[0]!.code });
    const status = await mfaStatus(deps(), state(owner, "owner", true), "OwnerListing");
    expect(status.methods.map(m => m.label)).toEqual(["Authenticator app", "Text message to •••• 004"]);
    expect(JSON.stringify(status)).not.toContain("0400000004");
    expect(JSON.stringify(status)).not.toContain(s.value.secret);
    const before = new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid: owner, ut: "owner", exp: 4_000_000_000, mfa: Math.floor(Date.now() / 1000) - 60 }, "s".repeat(40))}` } });
    expect(await actorFromRequestChecked(t.db, before, "s".repeat(40), Math.floor(Date.now() / 1000))).not.toBeNull();
    expect((await removeFactor(deps(), state(owner, "owner", true), totp!.id)).ok).toBe(true);
    expect(await actorFromRequestChecked(t.db, before, "s".repeat(40), Math.floor(Date.now() / 1000))).toBeNull();
    expect((await removeFactor(deps(), state(owner, "owner", true), "00000000-0000-4000-8000-000000000000")).ok).toBe(false);
  });

  it("fails closed without a usable MFA_SECRET_KEY", async () => {
    const owner = await addUser(t.db, "owner");
    for (const key of [undefined, "short"]) {
      expect((await startTotp(deps({ key }), owner)).ok).toBe(false);
      expect((await verifySecondFactor(deps({ key }), owner, IP, { method: "totp", code: "123456" })).ok).toBe(false);
      expect((await startSms(deps({ key }), owner, IP, { phone: "0400 000 005", consent: true })).ok).toBe(false);
    }
    expect(sent).toEqual([]);
    expect((await mfaStatus(deps({ key: undefined }), state(owner, "owner", false), "OwnerListing")).available).toEqual({ totp: false, sms: false });
  });

  it("refuses to change the event log", async () => {
    const owner = await addUser(t.db, "owner");
    await startTotp(deps(), owner);
    await expect(t.db.query("DELETE FROM mfa_event_log WHERE user_id = $1", [owner])).rejects.toThrow();
  });
});
