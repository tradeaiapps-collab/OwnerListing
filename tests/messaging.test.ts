import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSmtpEmail, emailFromEnv, mapSmtpError, type MailTransport } from "../src/adapters/email";
import { SmsSendError, createTwilioSms, createUnconfiguredSms, mapTwilioError, smsFromEnv } from "../src/adapters/sms";
import { isPublicAddress } from "../src/domain/net-guard";
import { MessagingKeyError, openSetting, sealSetting } from "../src/domain/messaging-crypto";
import {
  ENV_NAMES, FIELDS, displayValue, isE164, isEmailAddress, resolveMessaging, validateField, type SmsConfig, type SmtpConfig
} from "../src/domain/messaging-settings";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, dbTouched: 0, saved: [] as unknown[] }));
vi.mock("../src/server/context", () => ({
  getActor: () => null,
  getDb: () => { state.dbTouched++; return { query: async () => ({ rows: [] }) }; },
  getStaff: async () => state.staff
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/messaging-settings-db", () => ({
  loadStored: async () => ({}),
  loadFieldStates: async () => Object.fromEntries(["sms.provider", "sms.accountSid", "sms.authToken", "sms.apiKeySid", "sms.sender", "email.host", "email.port", "email.user", "email.password", "email.from"].map(f => [f, { set: false, source: "none" }])),
  saveSettings: async (...a: unknown[]) => { state.saved.push(a[2]); }
}));

import * as settingsRoute from "../app/api/staff/messaging/route";
import * as testRoute from "../app/api/staff/messaging/test/route";

const KEY = randomBytes(32).toString("base64");
const SID = "AC" + "a".repeat(32);
const TOKEN = "t0ken-secret-value-1234567890abcd";
const smsCfg: SmsConfig = { provider: "twilio", accountSid: SID, authToken: TOKEN, sender: "+61400000001" };
const PUBLIC = async () => ["93.184.216.34"];
const smtpCfg: SmtpConfig = { host: "smtp.example.test", port: 587, user: "mailer", password: "smtp-pass-secret", from: "no-reply@example.test" };

describe("setting validation", () => {
  it("accepts good values and rejects bad ones", () => {
    expect(validateField("sms.sender", "+61400000001").ok).toBe(true);
    expect(validateField("sms.sender", "OwnerList").ok).toBe(true);
    expect(validateField("sms.sender", "MG" + "b".repeat(32)).ok).toBe(true);
    expect(validateField("sms.sender", "0400 000 000").ok).toBe(false);
    expect(validateField("sms.sender", "12345").ok).toBe(false);
    expect(validateField("sms.sender", "TooLongSenderId").ok).toBe(false);
    expect(validateField("sms.accountSid", "ACnothex").ok).toBe(false);
    expect(validateField("sms.authToken", "short").ok).toBe(false);
    expect(validateField("sms.provider", "other").ok).toBe(false);
    expect(validateField("email.port", "70000").ok).toBe(false);
    expect(validateField("email.port", "587").ok).toBe(true);
    expect(validateField("email.host", "bad host").ok).toBe(false);
    expect(validateField("email.from", "a@b.test\r\nBcc: x@y.test").ok).toBe(false);
    expect(validateField("email.from", "no-reply@example.test").ok).toBe(true);
    expect(isE164("+61400000001")).toBe(true);
    expect(isE164("0400000001")).toBe(false);
    expect(isE164("+614000000011111111")).toBe(false);
  });
});

describe("resolving settings", () => {
  it("is off until everything needed is present and valid (fail closed)", () => {
    expect(resolveMessaging({}, {})).toEqual({ sms: null, email: null });
    expect(resolveMessaging({ "sms.accountSid": SID, "sms.authToken": TOKEN, "sms.sender": "+61400000001" }, {}).sms).toBeNull(); // no provider
    expect(resolveMessaging({ "sms.provider": "twilio", "sms.accountSid": "bad", "sms.authToken": TOKEN, "sms.sender": "+61400000001" }, {}).sms).toBeNull();
    expect(resolveMessaging({ "email.host": "h.test", "email.port": "587" }, {}).email).toBeNull(); // no from
    expect(resolveMessaging({ "email.host": "h.test", "email.port": "587", "email.from": "a@b.test", "email.user": "u" }, {}).email).toBeNull(); // lone user
  });
  it("environment overrides the database per field", () => {
    const stored = { "sms.provider": "twilio", "sms.accountSid": SID, "sms.authToken": TOKEN, "sms.sender": "+61400000001" } as const;
    expect(resolveMessaging(stored, {}).sms?.sender).toBe("+61400000001");
    expect(resolveMessaging(stored, { SMS_SENDER: "OwnerList" }).sms?.sender).toBe("OwnerList");
    expect(resolveMessaging(stored, { SMS_SENDER: "not valid!!" }).sms).toBeNull(); // a bad override does not silently fall back
  });
  it("every env name is listed in .env.example", () => {
    const example = readFileSync(path.join(__dirname, "..", ".env.example"), "utf8");
    for (const f of FIELDS) expect(example).toMatch(new RegExp(`^${ENV_NAMES[f]}=`, "m"));
    expect(example).toMatch(/^MESSAGING_SETTINGS_KEY=/m);
  });
  it("never displays secrets and masks ids, numbers and addresses", () => {
    expect(displayValue("sms.authToken", TOKEN)).toBeUndefined();
    expect(displayValue("email.password", "x")).toBeUndefined();
    expect(displayValue("sms.sender", "+61400000001")).toBe("••••0001");
    expect(displayValue("email.host", "smtp.example.test")).toBe("smtp.example.test");
  });
});

describe("encryption of secrets", () => {
  it("round-trips, binds to the field and fails closed without a key", async () => {
    const sealed = await sealSetting(TOKEN, KEY, "sms.authToken");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(TOKEN);
    expect(await openSetting(sealed, KEY, "sms.authToken")).toBe(TOKEN);
    expect(await openSetting(sealed, KEY, "email.password")).toBeUndefined();
    expect(await openSetting(sealed, randomBytes(32).toString("base64"), "sms.authToken")).toBeUndefined();
    await expect(sealSetting(TOKEN, undefined, "sms.authToken")).rejects.toBeInstanceOf(MessagingKeyError);
    await expect(sealSetting(TOKEN, "short", "sms.authToken")).rejects.toBeInstanceOf(MessagingKeyError);
    await expect(openSetting(sealed, undefined, "sms.authToken")).rejects.toBeInstanceOf(MessagingKeyError);
  });
});

describe("Twilio SMS adapter", () => {
  const ok = () => new Response(JSON.stringify({ sid: "SM" + "c".repeat(32) }), { status: 201 });

  it("posts the documented request shape", async () => {
    const f = vi.fn(async () => ok());
    const r = await createTwilioSms(smsCfg, { fetch: f as never }).sendText("+61400000002", "Hello there");
    expect(r).toEqual({ status: "sent", providerRef: "SM" + "c".repeat(32) });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = init.headers as Record<string, string>;
    expect(h["authorization"]).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    expect(h["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toEqual({ To: "+61400000002", Body: "Hello there", From: "+61400000001" });
  });
  it("uses an alphanumeric sender id as From, a messaging service sid as MessagingServiceSid, and an API key for auth", async () => {
    const f = vi.fn(async () => ok());
    await createTwilioSms({ ...smsCfg, sender: "OwnerList" }, { fetch: f as never }).sendText("+61400000002", "x");
    expect(new URLSearchParams((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).get("From")).toBe("OwnerList");
    const svc = "MG" + "d".repeat(32);
    const key = "SK" + "e".repeat(32);
    await createTwilioSms({ ...smsCfg, sender: svc, apiKeySid: key }, { fetch: f as never }).sendText("+61400000002", "x");
    const [, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    const form = new URLSearchParams(init.body as string);
    expect(form.get("MessagingServiceSid")).toBe(svc);
    expect(form.has("From")).toBe(false);
    expect((init.headers as Record<string, string>)["authorization"]).toBe(`Basic ${Buffer.from(`${key}:${TOKEN}`).toString("base64")}`);
  });
  it("sendCode sends the code text and throws a code-only error on failure", async () => {
    const f = vi.fn(async () => ok());
    await createTwilioSms(smsCfg, { fetch: f as never }).sendCode("+61400000002", "123456");
    expect(new URLSearchParams((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).get("Body")).toContain("123456");
    const bad = createTwilioSms(smsCfg, { fetch: (async () => new Response(JSON.stringify({ code: 21211, message: "The 'To' number +61400000002 is not valid" }), { status: 400 })) as never });
    const e = (await bad.sendCode("+61400000002", "123456").catch(x => x)) as SmsSendError;
    expect(e).toBeInstanceOf(SmsSendError);
    expect(e.code).toBe("invalid_recipient");
    expect(`${e.message}${e.stack}`).not.toMatch(/61400000002|123456|t0ken|api\.twilio/);
  });
  it("maps errors to a fixed vocabulary and does not retry by itself", async () => {
    expect(mapTwilioError(401, 20003)).toEqual({ code: "auth_failed", retryable: false });
    expect(mapTwilioError(400, 21610)).toEqual({ code: "recipient_opted_out", retryable: false });
    expect(mapTwilioError(400, 21211)).toEqual({ code: "invalid_recipient", retryable: false });
    expect(mapTwilioError(429, undefined)).toEqual({ code: "rate_limited", retryable: true });
    expect(mapTwilioError(503, undefined)).toEqual({ code: "provider_unavailable", retryable: true });
    expect(mapTwilioError(400, 99999)).toEqual({ code: "rejected", retryable: false });
    const f = vi.fn(async () => new Response("oops", { status: 503 }));
    const r = await createTwilioSms(smsCfg, { fetch: f as never }).sendText("+61400000002", "x");
    expect(r).toEqual({ status: "failed", errorCode: "provider_unavailable", retryable: true });
    expect(f).toHaveBeenCalledTimes(1);
    const t = createTwilioSms(smsCfg, { fetch: (async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }) as never });
    expect(await t.sendText("+61400000002", "x")).toEqual({ status: "failed", errorCode: "timeout", retryable: true });
    const n = createTwilioSms(smsCfg, { fetch: (async () => { throw new Error("getaddrinfo ENOTFOUND api.twilio.com"); }) as never });
    expect(await n.sendText("+61400000002", "x")).toEqual({ status: "failed", errorCode: "network", retryable: true });
  });
  it("rejects a bad recipient or message before any request", async () => {
    const f = vi.fn(async () => ok());
    const p = createTwilioSms(smsCfg, { fetch: f as never });
    expect(await p.sendText("0400000002", "x")).toMatchObject({ status: "failed", errorCode: "invalid_recipient" });
    expect(await p.sendText("+61400000002", "")).toMatchObject({ status: "failed", errorCode: "invalid_message" });
    expect(f).not.toHaveBeenCalled();
  });
  it("really times out a hung request", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => { init.signal!.addEventListener("abort", () => rej(init.signal!.reason)); })) as never;
    const r = await createTwilioSms(smsCfg, { fetch: hang, timeoutMs: 20 }).sendText("+61400000002", "x");
    expect(r).toMatchObject({ status: "failed", errorCode: "timeout" });
  });
  it("writes nothing to the console", async () => {
    const spies = (["log", "error", "warn", "info", "debug"] as const).map(m => vi.spyOn(console, m).mockImplementation(() => undefined));
    await createTwilioSms(smsCfg, { fetch: (async () => new Response("{}", { status: 500 })) as never }).sendText("+61400000002", "x");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    spies.forEach(s => s.mockRestore());
  });
  it("is unconfigured from an empty environment and sends nothing", async () => {
    expect(smsFromEnv({}).configured).toBe(false);
    expect(await createUnconfiguredSms().sendText("+61400000002", "x")).toEqual({ status: "not_configured" });
    await expect(createUnconfiguredSms().sendCode("+61400000002", "1")).rejects.toBeInstanceOf(SmsSendError);
    const env = { SMS_PROVIDER: "twilio", SMS_ACCOUNT_SID: SID, SMS_AUTH_TOKEN: TOKEN, SMS_SENDER: "+61400000001" };
    expect(smsFromEnv(env).configured).toBe(true);
  });
});

describe("SMTP email adapter", () => {
  const transportFor = (sendMail: MailTransport["sendMail"]) => {
    const made: Record<string, unknown>[] = [];
    const close = vi.fn();
    return { made, close, factory: (o: Record<string, unknown>): MailTransport => { made.push(o); return { sendMail, close }; } };
  };

  it("passes attachments to the transport, and refuses a total over 25 MB or an unsafe file name", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "<a@example.test>" }));
    const t = transportFor(sendMail);
    const email = createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: PUBLIC });
    const pdf = { filename: "report-sales-2026-10-01-to-2026-10-07-2026-11-05.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" };
    expect((await email.send({ to: "buyer@example.test", subject: "Hi", text: "Body", attachments: [pdf] })).status).toBe("sent");
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ attachments: [pdf] }));
    const big = { ...pdf, content: Buffer.alloc(25 * 1024 * 1024 + 1) };
    expect(await email.send({ to: "buyer@example.test", subject: "Hi", text: "Body", attachments: [big] })).toMatchObject({ status: "failed", errorCode: "invalid_message" });
    expect(await email.send({ to: "buyer@example.test", subject: "Hi", text: "Body", attachments: [{ ...pdf, filename: "../etc/passwd" }] })).toMatchObject({ status: "failed" });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("builds a TLS-required transport and sends a plain-text message", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "<abc@example.test>" }));
    const t = transportFor(sendMail);
    const r = await createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: PUBLIC }).send({ to: "buyer@example.test", subject: "Hi", text: "Body" });
    expect(r).toEqual({ status: "sent", providerRef: "<abc@example.test>" });
    expect(t.made[0]).toMatchObject({ host: "93.184.216.34", port: 587, secure: false, tls: { servername: "smtp.example.test" }, requireTLS: true, auth: { user: "mailer", pass: "smtp-pass-secret" }, disableFileAccess: true, disableUrlAccess: true });
    expect(t.made[0]!["connectionTimeout"]).toBeGreaterThan(0);
    expect(sendMail).toHaveBeenCalledWith({ from: "no-reply@example.test", to: "buyer@example.test", subject: "Hi", text: "Body" });
    expect(t.close).toHaveBeenCalled();
  });

  it("sends the HTML part alongside the text, and refuses an oversized one", async () => {
    const sendMail = vi.fn(async () => ({}));
    const t = transportFor(sendMail);
    const port = createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: PUBLIC });
    await port.send({ to: "buyer@example.test", subject: "Hi", text: "Body", html: "<p>Body</p>" });
    expect(sendMail).toHaveBeenCalledWith({ from: "no-reply@example.test", to: "buyer@example.test", subject: "Hi", text: "Body", html: "<p>Body</p>" });
    expect(await port.send({ to: "buyer@example.test", subject: "Hi", text: "Body", html: "x".repeat(100_001) })).toMatchObject({ status: "failed", errorCode: "invalid_message" });
  });
  it("uses implicit TLS on 465 and no auth when none is configured", async () => {
    const t = transportFor(async () => ({}));
    await createSmtpEmail({ host: "h.test", port: 465, from: "a@b.test" }, { createTransport: t.factory, resolve: PUBLIC }).send({ to: "buyer@example.test", subject: "Hi", text: "x" });
    expect(t.made[0]).toMatchObject({ secure: true, requireTLS: false });
    expect(t.made[0]).not.toHaveProperty("auth");
  });
  it("maps failures to a fixed code and keeps the error text out", async () => {
    expect(mapSmtpError({ code: "EAUTH" })).toEqual({ code: "auth_failed", retryable: false });
    expect(mapSmtpError({ code: "ETIMEDOUT" })).toEqual({ code: "timeout", retryable: true });
    expect(mapSmtpError({ code: "ECONNECTION" })).toEqual({ code: "network", retryable: true });
    expect(mapSmtpError({ responseCode: 451 })).toEqual({ code: "provider_unavailable", retryable: true });
    expect(mapSmtpError({ responseCode: 550 })).toEqual({ code: "invalid_recipient", retryable: false });
    const t = transportFor(async () => { throw Object.assign(new Error("550 buyer@example.test rejected; pass smtp-pass-secret"), { code: "EENVELOPE" }); });
    const r = await createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: PUBLIC }).send({ to: "buyer@example.test", subject: "Hi", text: "x" });
    expect(r).toEqual({ status: "failed", errorCode: "invalid_recipient", retryable: false });
    expect(JSON.stringify(r)).not.toMatch(/buyer@|smtp-pass/);
    expect(t.close).toHaveBeenCalled();
  });
  it("refuses header injection and bad recipients before connecting", async () => {
    const t = transportFor(async () => ({}));
    const p = createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: PUBLIC });
    expect(await p.send({ to: "a@b.test\r\nBcc: x@y.test", subject: "Hi", text: "x" })).toMatchObject({ errorCode: "invalid_recipient" });
    expect(await p.send({ to: "a@b.test", subject: "Hi\r\nBcc: x@y.test", text: "x" })).toMatchObject({ errorCode: "invalid_message" });
    expect(t.made).toHaveLength(0);
  });
  it("is unconfigured from an empty environment and sends nothing", async () => {
    expect(emailFromEnv({}).configured).toBe(false);
    expect(await emailFromEnv({}).send({ to: "a@b.test", subject: "s", text: "t" })).toEqual({ status: "not_configured" });
  });
});

describe("staff messaging routes: who may use them", () => {
  const HEAD = { "content-type": "application/json", origin: "http://test" };
  const put = (body: unknown, headers: Record<string, string> = HEAD) => settingsRoute.PUT(new Request("http://test/api/staff/messaging", { method: "PUT", headers, body: JSON.stringify(body) }));
  const get = () => settingsRoute.GET(new Request("http://test/api/staff/messaging"));
  const sendTest = (body: unknown, headers: Record<string, string> = HEAD) => testRoute.POST(new Request("http://test/api/staff/messaging/test", { method: "POST", headers, body: JSON.stringify(body) }));
  const prevUrl = process.env["APP_URL"];
  const prevKey = process.env["MESSAGING_SETTINGS_KEY"];

  beforeEach(() => { state.staff = null; state.dbTouched = 0; state.saved = []; process.env["APP_URL"] = "http://test"; process.env["MESSAGING_SETTINGS_KEY"] = KEY; });
  afterEach(() => {
    if (prevUrl === undefined) delete process.env["APP_URL"]; else process.env["APP_URL"] = prevUrl;
    if (prevKey === undefined) delete process.env["MESSAGING_SETTINGS_KEY"]; else process.env["MESSAGING_SETTINGS_KEY"] = prevKey;
  });

  it("signed out (this also covers an owner or buyer, who have no staff session): 401, nothing touched", async () => {
    expect((await get()).status).toBe(401);
    expect((await put({ "sms.provider": "twilio" })).status).toBe(401);
    expect((await sendTest({ channel: "email" })).status).toBe(401);
    expect(state.dbTouched).toBe(0);
    expect(state.saved).toEqual([]);
  });
  it.each(["compliance", "accountant", "support", "technical", "reporting"] as const)("%s staff are refused: 403", async role => {
    state.staff = { id: "00000000-0000-4000-8000-000000000001", role };
    expect((await get()).status).toBe(403);
    expect((await put({ "sms.provider": "twilio" })).status).toBe(403);
    expect((await sendTest({ channel: "email" })).status).toBe(403);
    expect(state.dbTouched).toBe(0);
    expect(state.saved).toEqual([]);
  });
  it("cross-origin and wrong content type are refused before anything else, even for a super admin", async () => {
    state.staff = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
    expect((await put({ "sms.provider": "twilio" }, { ...HEAD, origin: "http://evil.test" })).status).toBe(403);
    expect((await put({ "sms.provider": "twilio" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await put({ "sms.provider": "twilio" }, { origin: "http://test", "content-type": "text/plain" })).status).toBe(403);
    expect((await sendTest({ channel: "email" }, { ...HEAD, origin: "http://evil.test" })).status).toBe(403);
    expect(state.saved).toEqual([]);
  });
  it("without the encryption key nothing is saved (503), including non-secret fields", async () => {
    state.staff = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
    delete process.env["MESSAGING_SETTINGS_KEY"];
    const r = await put({ "sms.provider": "twilio" });
    expect(r.status).toBe(503);
    expect((await r.json()).code).toBe("key_not_configured");
    process.env["MESSAGING_SETTINGS_KEY"] = "not-a-key";
    expect((await put({ "sms.provider": "twilio" })).status).toBe(503);
    expect(state.saved).toEqual([]);
    delete process.env["MESSAGING_SETTINGS_KEY"];
    const g = await (await get()).json();
    expect(g.keyConfigured).toBe(false);
  });
  it("super admin: validation errors are 400 and nothing is saved; good input is saved without echoing values", async () => {
    state.staff = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
    const bad = await put({ "sms.sender": "0400 000 000", "nope": "x" });
    expect(bad.status).toBe(400);
    expect(Object.keys((await bad.json()).fields).sort()).toEqual(["nope", "sms.sender"]);
    expect(state.saved).toEqual([]);
    expect((await put({})).status).toBe(400);
    const ok = await put({ "sms.authToken": TOKEN, "sms.sender": "+61400000001", "email.password": "" });
    expect(ok.status).toBe(200);
    expect(state.saved).toEqual([{ "sms.authToken": TOKEN, "sms.sender": "+61400000001", "email.password": null }]);
    const text = await ok.text();
    expect(text).not.toContain(TOKEN);
  });
  it("test send: validates input and refuses a bad number (400)", async () => {
    state.staff = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
    expect((await sendTest({ channel: "fax" })).status).toBe(400);
    expect((await sendTest({ channel: "sms", phone: "0400000001" })).status).toBe(400);
    for (const phone of ["+14155550100", "+61255550100", "+61190012345", "+6140000000", "+614000000011"]) expect((await sendTest({ channel: "sms", phone })).status, phone).toBe(400); // not an Australian mobile
    expect((await sendTest({ channel: "sms" })).status).toBe(400);
  });
});

describe("SSRF guard for the admin-entered SMTP host", () => {
  it("classifies addresses: only public ones pass", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
      "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "not-an-ip", ""]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.255.255", "2606:2800:220:1:248:1893:25c8:1946", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("refuses internal or numeric host names and unusual ports when saving", () => {
    for (const h of ["localhost", "db.internal", "mail.local", "intranet", "127.0.0.1", "2130706433", "0x7f.1", "169.254.169.254", "[::1]", "metadata.google.internal", "x.localhost"]) {
      expect(validateField("email.host", h).ok, h).toBe(false);
    }
    expect(validateField("email.host", "SMTP.Example.com")).toEqual({ ok: true, value: "smtp.example.com" });
    for (const port of ["22", "3306", "5432", "6379", "80", "0", "65535"]) expect(validateField("email.port", port).ok, port).toBe(false);
    for (const port of ["25", "465", "587", "2525"]) expect(validateField("email.port", port).ok, port).toBe(true);
    expect(isEmailAddress("a\x00b@example.test")).toBe(false);
  });
  it("send time: connects to the resolved public address, and never when any answer is internal (rebinding)", async () => {
    const t = (() => { const made: Record<string, unknown>[] = []; return { made, factory: (o: Record<string, unknown>): MailTransport => { made.push(o); return { sendMail: async () => ({}), close() { /* none */ } }; } }; })();
    const msg = { to: "buyer@example.test", subject: "Hi", text: "x" };
    const ok = await createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: async () => ["93.184.216.34"] }).send(msg);
    expect(ok.status).toBe("sent");
    expect(t.made[0]).toMatchObject({ host: "93.184.216.34", tls: { servername: "smtp.example.test", rejectUnauthorized: true } });
    for (const answers of [["127.0.0.1"], ["93.184.216.34", "169.254.169.254"], ["::1"], ["fd00:ec2::254"]]) {
      const r = await createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: async () => answers }).send(msg);
      expect(r).toEqual({ status: "failed", errorCode: "blocked_host", retryable: false });
    }
    expect(await createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: async () => { throw new Error("ENOTFOUND smtp.example.test"); } }).send(msg)).toEqual({ status: "failed", errorCode: "network", retryable: true });
    expect(await createSmtpEmail(smtpCfg, { createTransport: t.factory, resolve: async () => [] }).send(msg)).toMatchObject({ errorCode: "network" });
    expect(t.made).toHaveLength(1); // only the good one connected
  });
  it("an internal host already in the database or environment resolves to not configured", () => {
    expect(resolveMessaging({ "email.host": "localhost", "email.port": "587", "email.from": "a@b.test" }, {}).email).toBeNull();
    expect(resolveMessaging({}, { SMTP_HOST: "10.0.0.5", SMTP_PORT: "587", SMTP_FROM: "a@b.test" }).email).toBeNull();
    expect(resolveMessaging({ "email.host": "h.test", "email.port": "22", "email.from": "a@b.test" }, {}).email).toBeNull();
  });
});
