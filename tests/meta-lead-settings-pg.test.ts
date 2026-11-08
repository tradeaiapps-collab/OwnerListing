import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import type { Queryable } from "../src/server/db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({ db: null as unknown as Queryable, staff: null as StaffActor | null }));
vi.mock("../src/server/context", () => ({ getActor: () => null, getDb: () => state.db, getStaff: async () => state.staff }));

import * as settingsRoute from "../app/api/staff/meta-lead-settings/route";
import * as testRoute from "../app/api/staff/meta-lead-settings/test/route";
import { META_TEST_RATE } from "../src/domain/meta-lead-settings";
import { loadMetaConfig } from "../src/server/meta-lead-settings-db";

const KEY = randomBytes(32).toString("base64");
const SECRET = "app-secret-value-0123456789abcdef";
const VERIFY = "verify-token-0123456789";
const PAGE = "EAAB-page-token-" + "z".repeat(60);
const GOOD = { appId: "1234567890", appSecret: SECRET, verifyToken: VERIFY, pageToken: PAGE };
const HEAD = { "content-type": "application/json", origin: "http://test" };
const URL_ = "http://test/api/staff/meta-lead-settings";

describe.skipIf(!DATABASE_URL)("Meta lead settings on Postgres", () => {
  let t: TestDb;
  let db: Queryable;
  let admin: StaffActor;
  const keys = ["APP_URL", "PROVIDER_CREDENTIAL_KEY", "MESSAGING_SETTINGS_KEY", "MFA_SECRET_KEY", "META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "META_PAGE_ACCESS_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    t = await createTestDb(); db = t.db; state.db = db;
    admin = { id: await addUser(db, "admin"), role: "super_admin" };
  }, 60_000);
  afterAll(async () => { await t?.close(); });
  beforeEach(() => {
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env["APP_URL"] = "http://test"; process.env["MESSAGING_SETTINGS_KEY"] = KEY;
    state.staff = admin;
  });
  afterEach(async () => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
    await db.query("DELETE FROM meta_lead_setting"); await db.query("DELETE FROM meta_lead_test"); await db.query("DELETE FROM offer_submit_attempt WHERE bucket LIKE 'meta-test:%'");
  });

  const put = (body: unknown) => settingsRoute.PUT(new Request(URL_, { method: "PUT", headers: HEAD, body: JSON.stringify(body) }));
  const get = () => settingsRoute.GET(new Request(URL_));
  const del = () => settingsRoute.DELETE(new Request(URL_, { method: "DELETE", headers: HEAD }));
  const runTest = () => testRoute.POST(new Request(URL_ + "/test", { method: "POST", headers: HEAD, body: "{}" }));
  const graphOk = () => vi.fn(async (u: string) => new Response(JSON.stringify(String(u).includes("/me?") ? { id: "P1", name: "Acme Homes" } : { id: GOOD.appId }), { status: 200 }));

  it("applies the migration", () => { expect(t.applied).toContain("20261105250000_meta_lead_settings.sql"); });

  it("starts disconnected and saves keys encrypted, never returning or auditing a secret", async () => {
    let v = await (await get()).json();
    expect([v.status, v.configured, v.keyConfigured]).toEqual(["disconnected", false, true]);
    const r = await put(GOOD);
    expect(r.status).toBe(200);
    v = await r.json();
    expect([v.status, v.configured]).toEqual(["untested", true]);
    expect(v.fields.appId).toEqual({ set: true, source: "database", value: GOOD.appId });
    expect(v.fields.appSecret).toEqual({ set: true, source: "database" });
    const out = JSON.stringify(v);
    for (const s of [SECRET, VERIFY, PAGE]) expect(out).not.toContain(s);
    const rows = JSON.stringify((await db.query("SELECT * FROM meta_lead_setting")).rows);
    for (const s of [SECRET, VERIFY, PAGE]) expect(rows).not.toContain(s);
    const audit = JSON.stringify((await db.query("SELECT event_type, payload FROM audit_event WHERE aggregate_type = 'meta_lead_settings'")).rows);
    expect(audit).toContain("setting_changed");
    for (const s of [SECRET, VERIFY, PAGE]) expect(audit).not.toContain(s);
    expect(await loadMetaConfig(db, process.env)).toEqual(GOOD);
  });

  it("works with PROVIDER_CREDENTIAL_KEY and cannot be opened with a different key (fails closed)", async () => {
    process.env["PROVIDER_CREDENTIAL_KEY"] = randomBytes(32).toString("base64");
    expect((await put(GOOD)).status).toBe(200);
    expect(await loadMetaConfig(db, process.env)).toEqual(GOOD);
    process.env["PROVIDER_CREDENTIAL_KEY"] = randomBytes(32).toString("base64");
    expect(await loadMetaConfig(db, process.env)).toBeNull();
    delete process.env["PROVIDER_CREDENTIAL_KEY"];
    expect(await loadMetaConfig(db, process.env)).toBeNull();
  });

  it("reports saved keys that cannot be read after the encryption key changes", async () => {
    await put(GOOD);
    let v = await (await get()).json();
    expect(v.unreadable).toEqual([]);
    process.env["PROVIDER_CREDENTIAL_KEY"] = randomBytes(32).toString("base64");
    v = await (await get()).json();
    expect([v.status, v.configured, v.keyConfigured]).toEqual(["disconnected", false, true]);
    expect([...v.unreadable].sort()).toEqual(["appSecret", "pageToken", "verifyToken"]);
  });

  it("does not record a test result when the keys changed while Meta was answering", async () => {
    await put(GOOD);
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (String(u).includes("/me?")) await put({ pageToken: "EAAB-new-page-token-" + "y".repeat(40) });
      return new Response(JSON.stringify(String(u).includes("/me?") ? { id: "P1", name: "Acme Homes" } : { id: GOOD.appId }), { status: 200 });
    }));
    const d = await (await runTest()).json();
    expect(d.stale).toBe(true);
    const v = await (await get()).json();
    expect([v.status, v.test]).toEqual(["untested", null]);
  });

  it("refuses to save with no usable key, and rejects invalid or unknown fields without saving anything", async () => {
    delete process.env["MESSAGING_SETTINGS_KEY"];
    const nokey = await put(GOOD);
    expect([nokey.status, (await nokey.json()).code]).toEqual([503, "key_not_configured"]);
    process.env["MESSAGING_SETTINGS_KEY"] = KEY;
    const bad = await put({ appSecret: "short", appId: "abc", bogus: "x", pageToken: PAGE });
    const b = await bad.json();
    expect(bad.status).toBe(400);
    expect(Object.keys(b.fields).sort()).toEqual(["appId", "appSecret", "bogus"]);
    expect((await put({})).status).toBe(400);
    expect((await put([1])).status).toBe(400);
    expect((await db.query("SELECT 1 FROM meta_lead_setting")).rows).toHaveLength(0);
  });

  it("updates one field, keeps the others, and an empty string clears a field", async () => {
    await put(GOOD);
    await put({ pageToken: PAGE + "-new" });
    expect(await loadMetaConfig(db, process.env)).toEqual({ ...GOOD, pageToken: PAGE + "-new" });
    const v = await (await put({ appId: "" })).json();
    expect(v.fields.appId.set).toBe(false);
    expect(v.configured).toBe(true);
  });

  it("tests the connection, records the result, and shows Connected until a setting changes", async () => {
    await put(GOOD);
    vi.stubGlobal("fetch", graphOk());
    const r = await runTest();
    expect([r.status, (await r.json()).ok]).toEqual([200, true]);
    let v = await (await get()).json();
    expect([v.status, v.test.pageName, v.test.appChecked]).toEqual(["connected", "Acme Homes", true]);
    await put({ pageToken: PAGE + "-changed" });
    v = await (await get()).json();
    expect([v.status, v.test]).toEqual(["untested", null]);
  });

  it("shows a failed test without leaking keys, and refuses to test an incomplete connection", async () => {
    expect((await runTest()).status).toBe(409);
    await put(GOOD);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: PAGE } }), { status: 401 })));
    const r = await runTest();
    const d = await r.json();
    expect([r.status, d.ok]).toEqual([502, false]);
    expect(JSON.stringify(d)).not.toContain(PAGE);
    const v = await (await get()).json();
    expect(v.status).toBe("test_failed");
    expect(JSON.stringify(v)).not.toContain(PAGE);
  });

  it("limits tests per admin (a refused attempt still counts)", async () => {
    await put(GOOD);
    const f = graphOk(); vi.stubGlobal("fetch", f);
    for (let i = 0; i < META_TEST_RATE.perStaff; i++) expect((await runTest()).status).toBe(200);
    expect((await runTest()).status).toBe(429);
    expect(f.mock.calls.length).toBe(META_TEST_RATE.perStaff * 2);
  });

  it("disconnect removes saved keys and the test result, and is audited; environment keys stay and win", async () => {
    await put(GOOD);
    vi.stubGlobal("fetch", graphOk());
    await runTest();
    const v = await (await del()).json();
    expect([v.status, v.configured, v.test]).toEqual(["disconnected", false, null]);
    expect((await db.query("SELECT 1 FROM meta_lead_setting")).rows).toHaveLength(0);
    expect(await loadMetaConfig(db, process.env)).toBeNull();
    const ev = (await db.query("SELECT event_type FROM audit_event WHERE aggregate_type = 'meta_lead_settings' ORDER BY occurred_at")).rows.map(x => x["event_type"]);
    expect(ev).toContain("meta_lead.disconnected");
    expect(ev).toContain("meta_lead.tested");
    // re-connect
    await put(GOOD);
    expect((await loadMetaConfig(db, process.env))?.appSecret).toBe(SECRET);
    process.env["META_APP_SECRET"] = "env-secret-0123456789abcdef";
    expect((await loadMetaConfig(db, process.env))?.appSecret).toBe("env-secret-0123456789abcdef");
    const v2 = await (await del()).json();
    expect(v2.fields.appSecret.source).toBe("env");
  });

  it("is staff-only: signed out is 401, a role without ad_leads.manage is 403", async () => {
    state.staff = null;
    expect([(await get()).status, (await put(GOOD)).status, (await del()).status, (await runTest()).status]).toEqual([401, 401, 401, 401]);
    state.staff = { id: admin.id, role: "support" } as StaffActor;
    expect([(await get()).status, (await put(GOOD)).status, (await del()).status, (await runTest()).status]).toEqual([403, 403, 403, 403]);
  });

  it("rejects a write without a same-origin header (CSRF)", async () => {
    const r = await settingsRoute.PUT(new Request(URL_, { method: "PUT", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify(GOOD) }));
    expect(r.status).toBe(403);
  });
});
