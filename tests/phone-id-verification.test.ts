import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUnconfiguredIdCheck, idCheckFromEnv, type IdCheckPort } from "../src/adapters/id-check";
import { createUnconfiguredSms, smsFromEnv, type SmsPort } from "../src/adapters/sms";
import { ID_START_RATE, MAX_CODE_ATTEMPTS, SMS_SEND_RATE, hashCode, hashesEqual, normaliseAuMobile } from "../src/domain/phone-verification";
import type { Actor } from "../src/domain/listing-service";
import { handleIdCheckWebhook, startIdCheck, type IdStore } from "../src/server/id-check";
import { sendPhoneCode, verifyPhoneCode, type LiveCode, type PhoneDeps, type PhoneEvent, type PhoneStore } from "../src/server/phone-verification";

const SECRET = "k".repeat(40);
const USER = "b0000000-0000-4000-8000-000000000001";

// ---- in-memory stores that behave like the SQL ----
function fakePhoneStore(opts: { email?: boolean; phone?: boolean } = {}) {
  const hits = new Map<string, number>();
  const codes: { id: string; userId: string; phone: string; hash: string; expiresAt: number; attempts: number; consumed: boolean; seq: number }[] = [];
  const log: PhoneEvent[] = [];
  const consents: string[] = [];
  const sent: string[] = [];
  const st = { phoneVerifiedAt: null as string | null, phone: null as string | null, clock: Date.now(), takenBy: null as string | null };
  const store: PhoneStore = {
    async hit(b) { const n = (hits.get(b) ?? 0) + 1; hits.set(b, n); return n; },
    async state() { return { emailVerified: opts.email ?? true, phoneVerified: opts.phone ?? st.phoneVerifiedAt !== null }; },
    async recordConsent(_u, v) { sent.push("consent"); consents.push(v); },
    async createCode(userId, id, phone, hash, exp) {
      codes.filter(c => c.userId === userId).forEach(c => { c.consumed = true; });
      codes.push({ id, userId, phone, hash, expiresAt: Date.parse(exp), attempts: 0, consumed: false, seq: codes.length });
    },
    async takeGuess(userId, max): Promise<LiveCode | "none" | "locked"> {
      const open = codes.filter(c => c.userId === userId && !c.consumed).sort((a, b) => b.seq - a.seq)[0];
      if (!open) return "none";
      if (open.attempts >= max) return "locked";
      open.attempts++;
      return { id: open.id, phoneE164: open.phone, codeHash: open.hash, expired: open.expiresAt <= st.clock };
    },
    async consume(id) { const c = codes.find(x => x.id === id); if (!c || c.consumed) return false; c.consumed = true; return true; },
    async markVerified(_u, phone) { if (st.takenBy === phone) return false; st.phoneVerifiedAt = "now"; st.phone = phone; return true; },
    async log(_u, e) { log.push(e); }
  };
  return { store, codes, log, consents, sent, st, hits };
}

function smsPort(configured = true, fail = false) {
  const texts: { to: string; code: string }[] = [];
  const port: SmsPort = {
    configured,
    async sendCode(to, code) { sent.push("sms"); if (fail) throw new Error("boom"); texts.push({ to, code }); }
  };
  return { port, texts };
}
let sent: string[] = [];

const body = { phone: "0400 000 000", consent: true };
function setup(o: { configured?: boolean; fail?: boolean; secret?: string | undefined; email?: boolean } = {}) {
  const f = fakePhoneStore({ email: o.email ?? true });
  sent = f.sent;
  const s = smsPort(o.configured ?? true, o.fail ?? false);
  const deps: PhoneDeps = { store: f.store, sms: s.port, secret: "secret" in o ? o.secret : SECRET, now: () => f.st.clock };
  return { f, s, deps };
}

describe("ports fail closed until a provider is configured", () => {
  it("default SMS and ID ports report unconfigured and refuse to act", async () => {
    expect(smsFromEnv({}).configured).toBe(false);
    expect(smsFromEnv({ SMS_CODE_SECRET: SECRET }).configured).toBe(false);
    await expect(createUnconfiguredSms().sendCode("+61400000000", "123456")).rejects.toThrow();
    expect(idCheckFromEnv({}).configured).toBe(false);
    await expect(createUnconfiguredIdCheck().startSession("x")).rejects.toThrow();
  });
  it("send and verify answer unavailable and touch nothing while unconfigured or the secret is missing/short", async () => {
    for (const o of [{ configured: false }, { secret: undefined }, { secret: "short" }]) {
      const { f, deps } = setup(o);
      const a = await sendPhoneCode(deps, USER, "1.2.3.4", body);
      const b = await verifyPhoneCode(deps, USER, "1.2.3.4", { code: "123456" });
      expect(a).toMatchObject({ ok: false, code: "unavailable" });
      expect(b).toMatchObject({ ok: false, code: "unavailable" });
      expect(f.consents).toEqual([]);
      expect(f.codes).toEqual([]);
    }
  });
});

describe("normaliseAuMobile", () => {
  it("accepts AU mobiles in common forms and rejects everything else", () => {
    for (const v of ["0400 000 000", "0400000000", "+61 400 000 000", "61400000000", "(04) 0000-0000"]) expect(normaliseAuMobile(v), v).toBe("+61400000000");
    for (const v of ["0212345678", "+64400000000", "040000000", "04000000000", "abc", "", 400000000, null, "0400000000; DROP TABLE x"]) expect(normaliseAuMobile(v), String(v)).toBeUndefined();
  });
});

describe("sendPhoneCode", () => {
  it("records consent BEFORE the SMS is sent, stores only a hash, and texts a 6-digit code", async () => {
    const { f, s, deps } = setup();
    const r = await sendPhoneCode(deps, USER, "1.2.3.4", body);
    expect(r).toEqual({ ok: true, value: { expiresInMinutes: 10 } });
    expect(f.sent).toEqual(["consent", "sms"]);
    expect(f.consents).toEqual(["2026-10-24"]);
    expect(s.texts).toHaveLength(1);
    expect(s.texts[0]!.to).toBe("+61400000000");
    const code = s.texts[0]!.code;
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(f.codes)).not.toContain(code);
    expect(f.codes[0]!.hash).toBe(hashCode(SECRET, USER, f.codes[0]!.id, code));
    expect(f.codes[0]!.expiresAt - f.st.clock).toBe(10 * 60 * 1000);
    expect(f.log).toEqual(["code_sent"]);
  });
  it("sends nothing and records no consent without consent === true", async () => {
    for (const consent of [false, undefined, "true", 1, "on"]) {
      const { f, s, deps } = setup();
      expect(await sendPhoneCode(deps, USER, "ip", { phone: "0400000000", consent })).toMatchObject({ ok: false, code: "invalid" });
      expect(f.consents).toEqual([]);
      expect(s.texts).toEqual([]);
    }
    const { s, deps } = setup();
    expect(await sendPhoneCode(deps, USER, "ip", null)).toMatchObject({ ok: false, code: "invalid" });
    expect(s.texts).toEqual([]);
  });
  it("rejects a bad number, an unverified email and an already verified phone", async () => {
    const a = setup();
    expect(await sendPhoneCode(a.deps, USER, "ip", { phone: "12345", consent: true })).toMatchObject({ ok: false, code: "invalid" });
    const b = setup({ email: false });
    expect(await sendPhoneCode(b.deps, USER, "ip", body)).toMatchObject({ ok: false, code: "forbidden" });
    expect(b.s.texts).toEqual([]);
    const c = setup();
    c.f.st.phoneVerifiedAt = "x";
    expect(await sendPhoneCode(c.deps, USER, "ip", body)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("rate limits per user, per IP and per phone number, and sends no text once over", async () => {
    const u = setup();
    for (let i = 0; i < SMS_SEND_RATE.perUser; i++) {
      // distinct phones and IPs so only the per-user limit can trip
      expect((await sendPhoneCode(u.deps, USER, `10.0.0.${i}`, { phone: `04000000${10 + i}`, consent: true })).ok).toBe(true);
    }
    expect(await sendPhoneCode(u.deps, USER, "10.0.1.1", { phone: "0400000099", consent: true })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(u.s.texts).toHaveLength(SMS_SEND_RATE.perUser);
    expect(u.f.log).toContain("rate_limited");

    const ip = setup();
    for (let i = 0; i < SMS_SEND_RATE.perIp; i++) expect((await sendPhoneCode(ip.deps, `u${i}`, "9.9.9.9", { phone: `04000001${10 + i}`, consent: true })).ok).toBe(true);
    expect(await sendPhoneCode(ip.deps, "u99", "9.9.9.9", { phone: "0400000199", consent: true })).toMatchObject({ ok: false, code: "rate_limited" });

    const ph = setup();
    for (let i = 0; i < SMS_SEND_RATE.perPhone; i++) expect((await sendPhoneCode(ph.deps, `u${i}`, `8.8.8.${i}`, body)).ok).toBe(true);
    expect(await sendPhoneCode(ph.deps, "u77", "8.8.8.77", body)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(ph.s.texts).toHaveLength(SMS_SEND_RATE.perPhone);
  });
  it("fails closed when the provider throws: code is invalidated, failure logged, no leak of the error", async () => {
    const { f, deps } = setup({ fail: true });
    const r = await sendPhoneCode(deps, USER, "ip", body);
    expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(JSON.stringify(r)).not.toContain("boom");
    expect(f.codes[0]!.consumed).toBe(true);
    expect(f.log).toEqual(["send_failed"]);
  });
  it("a new code replaces the old one, which no longer works", async () => {
    const { s, deps } = setup();
    await sendPhoneCode(deps, USER, "ip", body);
    await sendPhoneCode(deps, USER, "ip2", body);
    const [first, second] = s.texts;
    expect(await verifyPhoneCode(deps, USER, "ip", { code: second!.code })).toEqual({ ok: true, value: { verified: true } });
    expect(first!.code === second!.code).toBe(false);
  });
});

describe("verifyPhoneCode", () => {
  async function sentCode(o = {}) {
    const x = setup(o);
    await sendPhoneCode(x.deps, USER, "ip", body);
    return { ...x, code: x.s.texts[0]!.code };
  }
  const wrongOf = (c: string) => (c === "000000" ? "000001" : "000000");

  it("sets phone_verified_at (and stores the number) only on the correct code, once", async () => {
    const { f, deps, code } = await sentCode();
    expect(f.st.phoneVerifiedAt).toBeNull();
    expect(await verifyPhoneCode(deps, USER, "ip", { code })).toEqual({ ok: true, value: { verified: true } });
    expect(f.st.phoneVerifiedAt).not.toBeNull();
    expect(f.st.phone).toBe("+61400000000");
    expect(f.log).toEqual(["code_sent", "verified"]);
    // single use
    f.st.phoneVerifiedAt = null;
    expect(await verifyPhoneCode(deps, USER, "ip", { code })).toMatchObject({ ok: false });
    expect(f.st.phoneVerifiedAt).toBeNull();
  });
  it("a number already verified on another account cannot verify this one (generic answer, nothing set)", async () => {
    const { f, deps, code } = await sentCode();
    f.st.takenBy = "+61400000000";
    const r = await verifyPhoneCode(deps, USER, "ip", { code });
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(JSON.stringify(r)).not.toMatch(/another|account|taken|already/i);
    expect(f.st.phoneVerifiedAt).toBeNull();
    expect(f.log).not.toContain("verified");
  });
  it("rate-limit buckets and the logged IP are keyed hashes, not plain SHA-256 of the phone or IP", async () => {
    const { f, deps } = setup();
    await sendPhoneCode(deps, USER, "1.2.3.4", body);
    const plain = (v: string) => createHash("sha256").update(v).digest("hex");
    for (const k of [`sms-send:phone:+61400000000`, `sms-send:ip:1.2.3.4`]) {
      expect(f.hits.has(plain(k))).toBe(false);
      expect(f.hits.has(createHmac("sha256", SECRET).update(k).digest("hex"))).toBe(true);
    }
  });
  it("a wrong code never verifies, and never says whether it was close", async () => {
    const { f, deps, code } = await sentCode();
    const r = await verifyPhoneCode(deps, USER, "ip", { code: wrongOf(code) });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(f.st.phoneVerifiedAt).toBeNull();
    expect(f.log).toContain("code_wrong");
  });
  it("rejects malformed codes without counting a guess", async () => {
    const { f, deps } = await sentCode();
    for (const code of ["12345", "1234567", "abcdef", "12 456", "", 123456, null, undefined, { $ne: 1 }]) {
      expect(await verifyPhoneCode(deps, USER, "ip", { code })).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(f.codes[0]!.attempts).toBe(0);
  });
  it("expires after 10 minutes", async () => {
    const { f, deps, code } = await sentCode();
    f.st.clock += 10 * 60 * 1000 - 1;
    const probe = await verifyPhoneCode(deps, USER, "ip", { code: wrongOf(code) });
    expect(probe).toMatchObject({ ok: false });
    f.st.clock += 1;
    const r = await verifyPhoneCode(deps, USER, "ip", { code });
    expect(r).toMatchObject({ ok: false, code: "invalid", message: expect.stringContaining("expired") });
    expect(f.st.phoneVerifiedAt).toBeNull();
    expect(f.log).toContain("code_expired");
  });
  it("brute force: 5 wrong guesses lock the code, even the right code fails afterwards", async () => {
    const { f, deps, code } = await sentCode();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      expect(await verifyPhoneCode(deps, USER, `1.1.1.${i}`, { code: wrongOf(code) })).toMatchObject({ ok: false, code: "invalid" });
    }
    const locked = await verifyPhoneCode(deps, USER, "1.1.1.9", { code });
    expect(locked).toMatchObject({ ok: false, code: "rate_limited" });
    expect(f.st.phoneVerifiedAt).toBeNull();
    expect(f.log.filter(e => e === "code_locked")).toHaveLength(1);
  });
  it("the fifth guess is still allowed to be right", async () => {
    const { f, deps, code } = await sentCode();
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) await verifyPhoneCode(deps, USER, "ip", { code: wrongOf(code) });
    expect((await verifyPhoneCode(deps, USER, "ip", { code })).ok).toBe(true);
    expect(f.st.phoneVerifiedAt).not.toBeNull();
  });
  it("brute force across many fresh codes is stopped by the per-user verify rate limit", async () => {
    const { f, deps, s } = await sentCode();
    let limited = false;
    for (let i = 0; i < 12; i++) {
      await sendPhoneCode(deps, USER, "ip", { phone: `04000002${10 + i}`, consent: true });
      const code = s.texts.at(-1)?.code ?? "000000";
      const r = await verifyPhoneCode(deps, USER, "ip", { code: wrongOf(code) });
      if (!r.ok && r.code === "rate_limited") limited = true;
    }
    expect(limited).toBe(true);
    expect(f.st.phoneVerifiedAt).toBeNull();
  });
  it("brute force from one IP across many users is stopped by the per-IP limit", async () => {
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const { deps } = await sentCode();
      const r = await verifyPhoneCode({ ...deps, store: { ...deps.store, hit: ipOnlyCounter } }, `user-${i}`, "7.7.7.7", { code: "123456" });
      if (!r.ok && r.code === "rate_limited") limited = true;
    }
    expect(limited).toBe(true);
  });
  it("a code from another user's row cannot verify this user (hash is bound to user and code id)", () => {
    const a = hashCode(SECRET, "user-a", "code-1", "123456");
    expect(hashesEqual(a, hashCode(SECRET, "user-b", "code-1", "123456"))).toBe(false);
    expect(hashesEqual(a, hashCode(SECRET, "user-a", "code-2", "123456"))).toBe(false);
    expect(hashesEqual(a, hashCode("z".repeat(40), "user-a", "code-1", "123456"))).toBe(false);
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, "nothex")).toBe(false);
    expect(hashesEqual("", "")).toBe(false);
  });
  it("fails closed when the rate-limit store returns nothing usable", async () => {
    const { deps, code } = await sentCode();
    const broken = { ...deps, store: { ...deps.store, hit: async () => undefined } };
    expect(await verifyPhoneCode(broken, USER, "ip", { code })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await sendPhoneCode(broken, USER, "ip", body)).toMatchObject({ ok: false, code: "rate_limited" });
  });
});
const ipCounts = new Map<string, number>();
async function ipOnlyCounter(bucket: string) { const n = (ipCounts.get(bucket) ?? 0) + 1; ipCounts.set(bucket, n); return n; }

// ---- ID check ----
function fakeIdStore(o: { phone?: boolean; id?: boolean } = {}) {
  const sessions = new Map<string, { userId: string; outcome: string }>();
  const events = new Set<string>();
  const logs: string[] = [];
  const hits = new Map<string, number>();
  const st = { idVerified: o.id ?? false };
  const store: IdStore = {
    async hit(b) { const n = (hits.get(b) ?? 0) + 1; hits.set(b, n); return n; },
    async state() { return { phoneVerified: o.phone ?? true, idVerified: st.idVerified }; },
    async recordSession(u, ref) { sessions.set(ref, { userId: u, outcome: "started" }); },
    async log(_u, e) { logs.push(e); },
    async applyResult(eventId, ref, outcome) {
      const s = sessions.get(ref);
      if (!s) return "unknown";
      if (events.has(eventId)) return "duplicate";
      events.add(eventId);
      if (s.outcome !== "started") return "applied";
      s.outcome = outcome;
      if (outcome === "passed") st.idVerified = true;
      return "applied";
    }
  };
  return { store, sessions, logs, st };
}
const idPort = (configured = true, result: unknown = { providerRef: "prov-1", redirectUrl: "https://id.example/s/1" }): IdCheckPort => ({
  configured,
  async startSession() { if (result === "throw") throw new Error("down"); return result as { providerRef: string; redirectUrl: string }; }
});
const sign = (raw: string, secret: string) => createHmac("sha256", secret).update(raw).digest("hex");
const WH = "w".repeat(40);

describe("startIdCheck", () => {
  it("answers unavailable and creates nothing while the port is unconfigured", async () => {
    const f = fakeIdStore();
    expect(await startIdCheck({ store: f.store, port: idPort(false) }, USER)).toMatchObject({ ok: false, code: "unavailable" });
    expect(f.sessions.size).toBe(0);
    expect(f.logs).toEqual([]);
  });
  it("needs a verified mobile first and refuses when already verified", async () => {
    expect(await startIdCheck({ store: fakeIdStore({ phone: false }).store, port: idPort() }, USER)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await startIdCheck({ store: fakeIdStore({ id: true }).store, port: idPort() }, USER)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("stores only the provider reference, and returns an https redirect", async () => {
    const f = fakeIdStore();
    const r = await startIdCheck({ store: f.store, port: idPort() }, USER);
    expect(r).toEqual({ ok: true, value: { redirectUrl: "https://id.example/s/1" } });
    expect([...f.sessions.keys()]).toEqual(["prov-1"]);
    expect(f.sessions.get("prov-1")).toEqual({ userId: USER, outcome: "started" });
  });
  it("rejects a provider reply with a non-https or missing redirect, and provider errors", async () => {
    for (const bad of [{ providerRef: "p", redirectUrl: "http://x" }, { providerRef: "p", redirectUrl: "javascript:alert(1)" }, { providerRef: "", redirectUrl: "https://x" }, null, "throw"]) {
      const f = fakeIdStore();
      expect(await startIdCheck({ store: f.store, port: idPort(true, bad) }, USER), JSON.stringify(bad)).toMatchObject({ ok: false, code: "unavailable" });
      expect(f.sessions.size).toBe(0);
    }
  });
  it("rate limits starts per user", async () => {
    const f = fakeIdStore();
    for (let i = 0; i < ID_START_RATE.perUser; i++) expect((await startIdCheck({ store: f.store, port: idPort() }, USER)).ok).toBe(true);
    expect(await startIdCheck({ store: f.store, port: idPort() }, USER)).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("handleIdCheckWebhook", () => {
  const ev = (o: Record<string, unknown> = {}) => JSON.stringify({ eventId: randomUUID(), providerRef: "prov-1", outcome: "passed", ...o });
  async function started() {
    const f = fakeIdStore();
    await startIdCheck({ store: f.store, port: idPort() }, USER);
    return f;
  }
  it("rejects everything while the secret is unset (503) and on a bad, missing or malformed signature (401)", async () => {
    const f = await started();
    const raw = ev();
    expect((await handleIdCheckWebhook(f.store, raw, sign(raw, WH), undefined)).status).toBe(503);
    expect((await handleIdCheckWebhook(f.store, raw, null, WH)).status).toBe(401);
    expect((await handleIdCheckWebhook(f.store, raw, "zz", WH)).status).toBe(401);
    expect((await handleIdCheckWebhook(f.store, raw, sign(raw, "x".repeat(40)), WH)).status).toBe(401);
    expect((await handleIdCheckWebhook(f.store, raw, sign(raw + " ", WH), WH)).status).toBe(401);
    expect(f.st.idVerified).toBe(false);
  });
  it("a correctly signed pass marks the buyer verified; a replay is ignored", async () => {
    const f = await started();
    const raw = ev({ eventId: "evt-1" });
    expect((await handleIdCheckWebhook(f.store, raw, sign(raw, WH), WH)).status).toBe(200);
    expect(f.st.idVerified).toBe(true);
    const again = await handleIdCheckWebhook(f.store, raw, sign(raw, WH), WH);
    expect(again.status).toBe(200);
    expect(again.body["note"]).toMatch(/Duplicate/);
  });
  it("a failed result never verifies, and a later pass for the same session cannot override it", async () => {
    const f = await started();
    const bad = ev({ outcome: "failed" });
    expect((await handleIdCheckWebhook(f.store, bad, sign(bad, WH), WH)).status).toBe(200);
    expect(f.st.idVerified).toBe(false);
    const good = ev();
    await handleIdCheckWebhook(f.store, good, sign(good, WH), WH);
    expect(f.st.idVerified).toBe(false);
  });
  it("unknown provider reference is a 404 and verifies nobody", async () => {
    const f = await started();
    const raw = ev({ providerRef: "someone-else" });
    expect((await handleIdCheckWebhook(f.store, raw, sign(raw, WH), WH)).status).toBe(404);
    expect(f.st.idVerified).toBe(false);
  });
  it("an unknown reference does not burn the event id: the retry after the session is recorded still applies", async () => {
    const f = fakeIdStore();
    const raw = ev({ providerRef: "late-ref" });
    expect((await handleIdCheckWebhook(f.store, raw, sign(raw, WH), WH)).status).toBe(404);
    f.sessions.set("late-ref", { userId: USER, outcome: "started" });
    const r = await handleIdCheckWebhook(f.store, raw, sign(raw, WH), WH);
    expect(r.status).toBe(200);
    expect(r.body["note"]).toBeUndefined();
    expect(f.st.idVerified).toBe(true);
  });
  it("a short webhook secret is treated as unset", async () => {
    const raw = ev();
    expect((await handleIdCheckWebhook(fakeIdStore().store, raw, sign(raw, "short"), "short")).status).toBe(503);
  });
  it("rejects malformed or unexpected payloads and oversized bodies even when signed", async () => {
    const f = await started();
    for (const raw of ["not json", "null", "[]", ev({ outcome: "approved" }), ev({ eventId: "" }), ev({ providerRef: 5 }), ev({ outcome: undefined })]) {
      expect((await handleIdCheckWebhook(f.store, raw, sign(raw, WH), WH)).status, raw).toBe(400);
    }
    const big = JSON.stringify({ pad: "x".repeat(20_000) });
    expect((await handleIdCheckWebhook(f.store, big, sign(big, WH), WH)).status).toBe(413);
    expect(f.st.idVerified).toBe(false);
  });
  it("the stored session carries no image or document fields", async () => {
    const f = await started();
    expect(Object.keys(f.sessions.get("prov-1")!).sort()).toEqual(["outcome", "userId"]);
  });
});

// ---- routes ----
const state = vi.hoisted(() => ({ actor: null as Actor | null }));
vi.mock("../src/server/context", () => ({ getActor: () => state.actor, getDb: () => null, getDeps: () => null }));
const route = vi.hoisted(() => ({ phone: null as unknown, id: null as unknown }));
vi.mock("../src/server/verification-context", () => ({
  getPhoneDeps: () => route.phone,
  getIdDeps: () => route.id,
  verificationAvailability: () => ({ phone: false, id: false })
}));

import { POST as idStartPost } from "../app/api/buyer/verification/id/start/route";
import { GET as optionsGet } from "../app/api/buyer/verification/options/route";
import { POST as sendPost } from "../app/api/buyer/verification/phone/send/route";
import { POST as verifyPost } from "../app/api/buyer/verification/phone/verify/route";
import { POST as webhookPost } from "../app/api/webhooks/id-check/route";

describe("routes", () => {
  const post = (url: string, o: { origin?: string | null; body?: unknown; json?: boolean } = {}) =>
    new Request(`http://test${url}`, {
      method: "POST",
      headers: { ...(o.origin === null ? {} : { origin: o.origin ?? "http://app.test" }), ...(o.json === false ? {} : { "content-type": "application/json" }) },
      body: JSON.stringify(o.body ?? body)
    });
  beforeEach(() => {
    process.env["APP_URL"] = "http://app.test";
    state.actor = { userId: USER, userType: "buyer" } as Actor;
    const x = setup();
    route.phone = x.deps;
    route.id = { store: fakeIdStore().store, port: idPort() };
  });

  it("csrfGuard runs first: cross-origin, missing origin and wrong content type get 403 before auth", async () => {
    state.actor = null;
    for (const [fn, url] of [[sendPost, "/api/buyer/verification/phone/send"], [verifyPost, "/api/buyer/verification/phone/verify"]] as const) {
      expect((await fn(post(url, { origin: "http://evil.test" }))).status).toBe(403);
      expect((await fn(post(url, { origin: null }))).status).toBe(403);
      expect((await fn(post(url, { json: false }))).status).toBe(403);
    }
    expect((await idStartPost(post("/api/buyer/verification/id/start", { origin: "http://evil.test" }))).status).toBe(403);
  });
  it("signed-out is 401 and non-buyers are 403, without sending or starting anything", async () => {
    state.actor = null;
    expect((await sendPost(post("/send"))).status).toBe(401);
    expect((await verifyPost(post("/verify"))).status).toBe(401);
    expect((await idStartPost(post("/start", { json: false }))).status).toBe(401);
    expect((await optionsGet(new Request("http://test/o"))).status).toBe(401);
    for (const userType of ["owner", "agent", "admin", "vendor"]) {
      state.actor = { userId: "u1", userType } as unknown as Actor;
      expect((await sendPost(post("/send"))).status).toBe(403);
      expect((await verifyPost(post("/verify"))).status).toBe(403);
      expect((await idStartPost(post("/start", { json: false }))).status).toBe(403);
      expect((await optionsGet(new Request("http://test/o"))).status).toBe(403);
    }
  });
  it("send then verify through the routes", async () => {
    const x = setup();
    route.phone = x.deps;
    expect((await sendPost(post("/send"))).status).toBe(200);
    expect((await verifyPost(post("/verify", { body: { code: x.s.texts[0]!.code } }))).status).toBe(200);
    expect(x.f.st.phoneVerifiedAt).not.toBeNull();
  });
  it("unconfigured SMS answers 503 'not available yet'", async () => {
    route.phone = setup({ configured: false }).deps;
    const res = await sendPost(post("/send"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not available yet/);
  });
  it("unconfigured ID check answers 503, and the options route reports both steps unavailable", async () => {
    route.id = { store: fakeIdStore().store, port: idPort(false) };
    expect((await idStartPost(post("/start", { json: false }))).status).toBe(503);
    const o = await (await optionsGet(new Request("http://test/o"))).json();
    expect(o.available).toEqual({ phone: false, id: false });
  });
  it("id start returns the redirect for a buyer with a verified mobile", async () => {
    const res = await idStartPost(post("/start", { json: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectUrl: "https://id.example/s/1" });
  });
  it("webhook route is 503 while ID_CHECK_WEBHOOK_SECRET is unset, and needs no cookie when signed", async () => {
    delete process.env["ID_CHECK_WEBHOOK_SECRET"];
    const f = fakeIdStore();
    await startIdCheck({ store: f.store, port: idPort() }, USER);
    route.id = { store: f.store, port: idPort() };
    const raw = JSON.stringify({ eventId: "e1", providerRef: "prov-1", outcome: "passed" });
    const mk = (sig: string) => new Request("http://test/api/webhooks/id-check", { method: "POST", headers: { "x-idcheck-signature": sig }, body: raw });
    expect((await webhookPost(mk(sign(raw, WH)))).status).toBe(503);
    process.env["ID_CHECK_WEBHOOK_SECRET"] = WH;
    state.actor = null;
    expect((await webhookPost(mk("0".repeat(64)))).status).toBe(401);
    expect((await webhookPost(mk(sign(raw, WH)))).status).toBe(200);
    expect(f.st.idVerified).toBe(true);
    delete process.env["ID_CHECK_WEBHOOK_SECRET"];
  });
});

// ---- migration and guarantees ----
describe("migration db/20261024180000_phone_id_verification.sql", () => {
  const dir = path.join(__dirname, "..", "db");
  const sql = readFileSync(path.join(dir, "20261024180000_phone_id_verification.sql"), "utf8");
  it("has a unique timestamp prefix", () => {
    const prefix = "20261024180000";
    expect(readdirSync(dir).filter(f => f.startsWith(prefix))).toHaveLength(1);
  });
  it("makes consent and both attempt logs append-only", () => {
    for (const t of ["phone_sms_consent", "phone_attempt_log", "id_check_log"]) {
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation`));
    }
  });
  it("allows one verified account per mobile number, and the unknown-reference path inserts no log row", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX \w+ ON buyer_verification\(phone_e164\) WHERE phone_verified_at IS NOT NULL/);
    const db = readFileSync(path.join(__dirname, "..", "src/server/phone-verification-db.ts"), "utf8");
    expect(db.indexOf("FROM id_check_session WHERE provider_ref")).toBeLessThan(db.indexOf("INSERT INTO id_check_log (event, provider_ref, event_id)"));
  });
  it("has no column for images, document numbers or a plaintext code", () => {
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/image|document_number|licence_number|passport_number|selfie|\bcode\s+(TEXT|CHAR)/i);
  });
  it("ID image availability is derived from config, not a constant that could be flipped to true", () => {
    expect(readFileSync(path.join(__dirname, "..", "src/domain/staff-admin.ts"), "utf8")).not.toMatch(/ID_IMAGES_AVAILABLE/);
    expect(readFileSync(path.join(__dirname, "..", "src/server/verification-context.ts"), "utf8")).toMatch(/idImages: idImagesAvailable\(\)/);
  });
});
