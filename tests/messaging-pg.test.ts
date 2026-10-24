import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailTransport } from "../src/adapters/email";
import type { AlertMessage } from "../src/domain/alerts";
import { MESSAGING_TEST_RATE } from "../src/domain/messaging-settings";
import type { StaffActor } from "../src/domain/staff-access";
import type { Queryable } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({ db: null as unknown as Queryable, staff: null as StaffActor | null }));
vi.mock("../src/server/context", () => ({ getActor: () => null, getDb: () => state.db, getStaff: async () => state.staff }));

import * as settingsRoute from "../app/api/staff/messaging/route";
import * as testRoute from "../app/api/staff/messaging/test/route";
import { alertDeliveryFor, createDbAlertDelivery, getSmsPort } from "../src/server/messaging";
import { loadResolved, saveSettings } from "../src/server/messaging-settings-db";

const KEY = randomBytes(32).toString("base64");
const SID = "AC" + "a".repeat(32);
const TOKEN = "t0ken-secret-value-1234567890abcd";
const SMTP_PASS = "smtp-pass-secret";
const SESSION = "s".repeat(40);
const HEAD = { "content-type": "application/json", origin: "http://test" };
const GOOD = { "sms.provider": "twilio", "sms.accountSid": SID, "sms.authToken": TOKEN, "sms.sender": "+61400000001" };

describe.skipIf(!DATABASE_URL)("messaging settings and outbox on Postgres", () => {
  let t: TestDb;
  let db: Queryable;
  let admin: StaffActor;
  const keys = ["APP_URL", "MESSAGING_SETTINGS_KEY", "SESSION_SECRET", "SMS_SENDER", "SMTP_HOST"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    t = await createTestDb(); db = t.db; state.db = db;
    const id = await addUser(db, "admin");
    admin = { id, role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env["APP_URL"] = "http://test"; process.env["MESSAGING_SETTINGS_KEY"] = KEY; process.env["SESSION_SECRET"] = SESSION;
    delete process.env["SMS_SENDER"]; delete process.env["SMTP_HOST"];
    state.staff = admin;
  });
  afterEach(async () => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
    await db.query("DELETE FROM messaging_setting");
  });

  const put = (body: unknown) => settingsRoute.PUT(new Request("http://test/api/staff/messaging", { method: "PUT", headers: HEAD, body: JSON.stringify(body) }));
  const outbox = async () => (await db.query("SELECT channel, template, recipient_hash, status, provider_ref, error_code FROM messaging_outbox ORDER BY created_at, id")).rows;

  it("applies the migration and keeps the outbox insert-only", async () => {
    expect(t.applied).toContain("20261025100000_messaging_settings.sql");
    await db.query("INSERT INTO messaging_outbox (channel, template, status) VALUES ('sms','unit_test','sent')");
    await expect(db.query("UPDATE messaging_outbox SET status = 'failed'")).rejects.toThrow(/insert-only/);
    await expect(db.query("DELETE FROM messaging_outbox")).rejects.toThrow(/insert-only/);
    await expect(db.query("TRUNCATE messaging_outbox")).rejects.toThrow(/insert-only/);
    await expect(db.query("INSERT INTO messaging_outbox (channel, template, status) VALUES ('fax','x','sent')")).rejects.toThrow();
    await expect(db.query("INSERT INTO messaging_outbox (channel, template, status, error_code) VALUES ('sms','x','failed','Bad Text +61400')")).rejects.toThrow();
  });

  it("saves secrets encrypted, audits field names only, and never returns the secret", async () => {
    const r = await put({ ...GOOD, "email.host": "smtp.example.test", "email.port": "587", "email.from": "no-reply@example.test", "email.user": "mailer", "email.password": SMTP_PASS });
    expect(r.status).toBe(200);
    const body = await r.text();
    for (const secret of [TOKEN, SMTP_PASS]) expect(body).not.toContain(secret);
    const view = JSON.parse(body);
    expect(view.fields["sms.authToken"]).toEqual({ set: true, source: "database" });
    expect(view.fields["email.password"]).toEqual({ set: true, source: "database" });
    expect(view.fields["sms.sender"]).toMatchObject({ set: true, display: "••••0001" });
    expect(view.smsConfigured).toBe(true);
    expect(view.emailConfigured).toBe(true);

    const rows = (await db.query("SELECT field, value, value_enc FROM messaging_setting")).rows;
    const tok = rows.find(x => x["field"] === "sms.authToken")!;
    expect(tok["value"]).toBeNull();
    expect(String(tok["value_enc"])).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(JSON.stringify(rows)).not.toContain(SMTP_PASS);

    const audit = (await db.query("SELECT actor_id, event_type, aggregate_id, payload FROM audit_event WHERE aggregate_type = 'messaging_settings'")).rows;
    expect(audit.length).toBe(9);
    expect(audit.every(a => a["actor_id"] === admin.id && a["event_type"] === "messaging.setting_changed")).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${TOKEN}|${SMTP_PASS}|61400000001|smtp.example`));

    const got = await (await settingsRoute.GET(new Request("http://test/api/staff/messaging"))).text();
    expect(got).not.toContain(TOKEN);
    expect(got).not.toContain(SMTP_PASS);

    const clear = await put({ "sms.authToken": "" });
    expect((await clear.json()).fields["sms.authToken"]).toEqual({ set: false, source: "none" });
    expect((await db.query("SELECT 1 FROM audit_event WHERE aggregate_id = 'sms.authToken' AND payload->>'action' = 'cleared'")).rows).toHaveLength(1);
  });

  it("saving a setting and its audit row are one transaction: if the audit write fails, the setting is not saved", async () => {
    const failingAudit: Queryable = {
      query: (text, params) => db.query(text, params),
      transaction: fn => db.transaction!(tx => fn({ query: (text, params) => (/audit_event/.test(text) ? Promise.reject(new Error("audit down")) : tx.query(text, params)) }))
    };
    await expect(saveSettings(failingAudit, admin, { "sms.sender": "+61400000009", "sms.authToken": TOKEN }, process.env)).rejects.toThrow(/audit down/);
    expect((await db.query("SELECT 1 FROM messaging_setting")).rows).toHaveLength(0);
  });

  it("fails closed without the key: nothing saved, nothing audited, and stored secrets stop resolving", async () => {
    await put(GOOD);
    expect((await loadResolved(db, process.env)).sms).not.toBeNull();
    const auditBefore = (await db.query("SELECT count(*)::int AS n FROM audit_event WHERE aggregate_type = 'messaging_settings'")).rows[0]!["n"];
    delete process.env["MESSAGING_SETTINGS_KEY"];
    const r = await put({ "sms.sender": "OwnerList" });
    expect(r.status).toBe(503);
    expect((await db.query("SELECT value FROM messaging_setting WHERE field = 'sms.sender'")).rows[0]!["value"]).toBe("+61400000001");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_event WHERE aggregate_type = 'messaging_settings'")).rows[0]!["n"]).toBe(auditBefore);
    await expect(saveSettings(db, admin, { "sms.authToken": TOKEN }, {})).rejects.toThrow(/MESSAGING_SETTINGS_KEY/);
    expect((await loadResolved(db, process.env)).sms).toBeNull();
    process.env["MESSAGING_SETTINGS_KEY"] = randomBytes(32).toString("base64"); // a different key cannot open them either
    expect((await loadResolved(db, process.env)).sms).toBeNull();
  });

  it("environment variables override the database, resolved at send time", async () => {
    await put(GOOD);
    const f = vi.fn(async () => new Response(JSON.stringify({ sid: "SM" + "c".repeat(32) }), { status: 201 }));
    const before = (await outbox()).length;
    const send = async () => (await getSmsPort(db, process.env, "unit_test", { fetch: f as never })).sendText("+61400000002", "hi");
    await send();
    expect(new URLSearchParams((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).get("From")).toBe("+61400000001");
    process.env["SMS_SENDER"] = "OwnerList";
    await send();
    expect(new URLSearchParams((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).get("From")).toBe("OwnerList");
    const rows = (await outbox()).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ channel: "sms", template: "unit_test", status: "sent", provider_ref: "SM" + "c".repeat(32), error_code: null });
    expect(JSON.stringify(rows)).not.toMatch(/61400000002|hi/);
    expect(String(rows[0]!["recipient_hash"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records not_configured and sends nothing when nothing is set", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const before = (await outbox()).length;
    const sms = await getSmsPort(db, process.env, "phone_code");
    expect(sms.configured).toBe(false);
    expect(await sms.sendText("+61400000002", "x")).toEqual({ status: "not_configured" });
    const make = vi.fn();
    const delivery = createDbAlertDelivery(db, process.env, { createTransport: make as never, resolve: async () => ["93.184.216.34"] });
    const msg = (channel: "email" | "sms"): AlertMessage => ({ buyerUserId: randomUUID(), channel, listingId: randomUUID(), searchId: randomUUID(), unsubscribeUrl: "http://test/u?t=1" });
    expect(await delivery.send(msg("email"))).toBe("not_configured");
    expect(await delivery.send(msg("sms"))).toBe("not_configured");
    expect(f).not.toHaveBeenCalled();
    expect(make).not.toHaveBeenCalled();
    const rows = (await outbox()).slice(before);
    expect(rows.map(r => [r["channel"], r["status"]])).toEqual([["sms", "not_configured"], ["email", "not_configured"], ["sms", "not_configured"]]);
  });

  it("alert delivery sends email and SMS through the adapters and records outbox rows without addresses", async () => {
    await put({ ...GOOD, "email.host": "smtp.example.test", "email.port": "587", "email.from": "no-reply@example.test" });
    const buyer = await addUser(db, "buyer");
    await db.query("INSERT INTO buyer_verification (user_id, phone_verified_at, phone_e164) VALUES ($1, now(), '+61400000009')", [buyer]);
    const email = String((await db.query("SELECT email FROM app_user WHERE id = $1", [buyer])).rows[0]!["email"]);
    const sendMail = vi.fn(async () => ({ messageId: "<m1@example.test>" }));
    const made: Record<string, unknown>[] = [];
    const f = vi.fn(async () => new Response(JSON.stringify({ sid: "SM" + "c".repeat(32) }), { status: 201 }));
    vi.stubGlobal("fetch", f);
    const delivery = createDbAlertDelivery(db, process.env, { resolve: async () => ["93.184.216.34"], createTransport: ((o: Record<string, unknown>) => { made.push(o); return { sendMail, close() { /* none */ } } satisfies MailTransport; }) as never });
    const listingId = randomUUID();
    const base = { buyerUserId: buyer, listingId, searchId: randomUUID(), unsubscribeUrl: "http://test/api/alerts/unsubscribe?t=abc" };
    const before = (await outbox()).length;
    expect(await delivery.send({ ...base, channel: "email" })).toBe("sent");
    expect(await delivery.send({ ...base, channel: "sms" })).toBe("sent");
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = (sendMail.mock.calls[0] as unknown as [{ to: string; text: string }])[0];
    expect(mail.to).toBe(email);
    expect(mail.text).toContain(`http://test/listings/${listingId}`);
    expect(mail.text).toContain("Unsubscribe: http://test/api/alerts/unsubscribe?t=abc");
    const form = new URLSearchParams((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(form.get("To")).toBe("+61400000009");
    expect(form.get("Body")).toContain("Opt out: http://test/api/alerts/unsubscribe?t=abc");
    const rows = (await outbox()).slice(before);
    expect(rows.map(r => [r["channel"], r["template"], r["status"]])).toEqual([["email", "alert_listing", "sent"], ["sms", "alert_listing", "sent"]]);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${email}|61400000009|abc`));
  });

  it("maps provider failures to 'failed' with a code, and a missing recipient to 'failed' without sending", async () => {
    await put(GOOD);
    const buyer = await addUser(db, "buyer"); // no verified phone
    const f = vi.fn(async () => new Response(JSON.stringify({ code: 20003 }), { status: 401 }));
    vi.stubGlobal("fetch", f);
    const delivery = createDbAlertDelivery(db, process.env);
    const m: AlertMessage = { buyerUserId: buyer, channel: "sms", listingId: randomUUID(), searchId: randomUUID(), unsubscribeUrl: "http://test/u" };
    const before = (await outbox()).length;
    expect(await delivery.send(m)).toBe("failed");
    expect(f).not.toHaveBeenCalled();
    await db.query("INSERT INTO buyer_verification (user_id, phone_verified_at, phone_e164) VALUES ($1, now(), '+61400000008')", [buyer]);
    expect(await delivery.send(m)).toBe("failed");
    expect(f).toHaveBeenCalledTimes(1);
    const rows = (await outbox()).slice(before);
    expect(rows.map(r => [r["status"], r["error_code"]])).toEqual([["failed", "no_recipient"], ["failed", "auth_failed"]]);
  });

  it("console delivery stays development-only; production never uses it", async () => {
    const consoleEnv = { ALERT_DELIVERY: "console", NODE_ENV: "development" };
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((l: string) => { lines.push(l); });
    const msg: AlertMessage = { buyerUserId: randomUUID(), channel: "email", listingId: randomUUID(), searchId: randomUUID(), unsubscribeUrl: "http://test/u" };
    expect(await alertDeliveryFor(db, consoleEnv).send(msg)).toBe("sent");
    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(await alertDeliveryFor(db, { ...consoleEnv, NODE_ENV: "production" }).send(msg)).toBe("not_configured");
  });

  it("test send: rate limited, audited, fails closed when unconfigured, and the email goes only to the admin's own address", async () => {
    const send = (body: unknown) => testRoute.POST(new Request("http://test/api/staff/messaging/test", { method: "POST", headers: HEAD, body: JSON.stringify(body) }));
    const f = vi.fn(async () => new Response(JSON.stringify({ sid: "SM" + "c".repeat(32) }), { status: 201 }));
    vi.stubGlobal("fetch", f);
    const other = await addUser(db, "admin");
    state.staff = { id: other, role: "super_admin" };
    const r1 = await send({ channel: "sms", phone: "+61400000003" });
    expect(r1.status).toBe(409);
    expect(f).not.toHaveBeenCalled();
    expect((await send({ channel: "email" })).status).toBe(409);
    await put(GOOD); // as `other`
    expect((await send({ channel: "sms", phone: "+61400000003" })).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
    expect((await send({ channel: "sms", phone: "+61400000003" })).status).toBe(200);
    expect((await send({ channel: "sms", phone: "+61400000003" })).status).toBe(200); // 5th counted call (two refused ones count too)
    expect((await send({ channel: "sms", phone: "+61400000003" })).status).toBe(429);
    expect(f).toHaveBeenCalledTimes(3);
    expect(MESSAGING_TEST_RATE.perStaff).toBe(5);
    // the overall cap also holds: another admin is refused once the shared bucket is used up
    await db.query("UPDATE offer_submit_attempt SET hits = $1 WHERE bucket = 'msg-test:all'", [MESSAGING_TEST_RATE.allStaff]);
    const third = await addUser(db, "admin");
    state.staff = { id: third, role: "super_admin" };
    expect((await send({ channel: "sms", phone: "+61400000003" })).status).toBe(429);
    expect(f).toHaveBeenCalledTimes(3);
    state.staff = { id: other, role: "super_admin" };
    const audit = (await db.query("SELECT payload FROM audit_event WHERE event_type = 'messaging.test_sent' AND actor_id = $1", [other])).rows;
    expect(audit.length).toBe(5);
    expect(JSON.stringify(audit)).not.toContain("61400000003");
  });
});
