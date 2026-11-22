import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({
  staff: null as StaffActor | null, calls: [] as unknown[][], audits: [] as string[], tickCalls: 0, clickTarget: null as string | null, openTokens: [] as string[]
}));

vi.mock("../src/server/context", () => ({
  getActor: () => null, getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff, getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z" })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/staff-automation-db", () => ({
  listRulesPg: async () => [], recentRunsPg: async () => [], createRulePg: async (_d: unknown, r: { name: string }) => { state.calls.push(["rule", r.name]); return "R1"; },
  getRulePg: async () => ({ id: "x" }), updateRulePg: async () => true, setRuleEnabledPg: async (_d: unknown, id: string, on: boolean) => { state.calls.push(["rule-enabled", id, on]); return true; },
  deleteRulePg: async () => "deleted"
}));
vi.mock("../src/server/scheduled-tasks-db", () => ({
  listTasksPg: async () => [], recentTaskRunsPg: async () => [], createTaskPg: async (_d: unknown, t: { name: string }) => { state.calls.push(["task", t.name]); return "T1"; },
  setTaskEnabledPg: async () => true, deleteTaskPg: async () => "deleted", runTaskNowPg: async (_d: unknown, id: string) => { state.calls.push(["task-run", id]); return true; }
}));
vi.mock("../src/server/campaigns-db", () => ({
  listCampaignsPg: async () => [], audienceCountPg: async () => 7, createCampaignPg: async (_d: unknown, c: { name: string }) => { state.calls.push(["campaign", c.name]); return "C1"; },
  getCampaignPg: async () => null, updateCampaignPg: async () => true,
  moveCampaignPg: async (_d: unknown, id: string, to: string) => { state.calls.push(["move", id, to]); return { ok: true }; },
  recordOpenPg: async (_d: unknown, t: string) => { state.openTokens.push(t); },
  recordClickPg: async () => state.clickTarget
}));
vi.mock("../src/server/staff-automation-run", () => ({ runAutomationTick: async () => { state.tickCalls++; return { aging: 0, campaigns: null, tasks: null, errors: [] }; } }));

import * as auto from "../app/api/staff/automation/route";
import * as autoOne from "../app/api/staff/automation/[id]/route";
import * as camp from "../app/api/staff/campaigns/route";
import * as campOne from "../app/api/staff/campaigns/[id]/route";
import * as open from "../app/api/campaigns/open/[token]/route";
import * as click from "../app/api/campaigns/click/[token]/route";
import * as cron from "../app/api/internal/staff-automation/run/route";
process.env["APP_URL"] = "http://test";

const admin: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
const support: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "support" };
const ID = "00000000-0000-4000-8000-000000000100";
const req = (method: string, url: string, body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", origin: "http://test" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = { params: Promise.resolve({ id: ID }) };
const rule = { resource: "rule", name: "Tell owner", trigger: "offer_received", recipient: "owner", title: "Offer", body: "An offer came in." };
const campaign = { name: "News", channel: "email", segment: "all_agents", subject: "Hi", body: "Hello" };

beforeEach(() => { state.staff = null; state.calls = []; state.audits = []; state.tickCalls = 0; state.clickTarget = null; state.openTokens = []; });

describe("staff automation routes", () => {
  it("need staff with automation.manage", async () => {
    expect((await auto.GET(req("GET", "http://test/api/staff/automation"))).status).toBe(401);
    state.staff = support;
    expect((await auto.GET(req("GET", "http://test/api/staff/automation"))).status).toBe(403);
    expect((await auto.POST(req("POST", "http://test/api/staff/automation", rule))).status).toBe(403);
    expect((await autoOne.PATCH(req("PATCH", "http://test/x", { action: "disable" }), ctx)).status).toBe(403);
    expect((await autoOne.DELETE(req("DELETE", "http://test/x"), ctx)).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("creates, switches and runs with an audit event for each change; refuses a bad rule", async () => {
    state.staff = admin;
    expect((await auto.GET(req("GET", "http://test/api/staff/automation"))).status).toBe(200);
    expect((await auto.POST(req("POST", "http://test/api/staff/automation", rule))).status).toBe(201);
    expect((await auto.POST(req("POST", "http://test/api/staff/automation", { ...rule, link: "https://evil.example" }))).status).toBe(400);
    expect((await auto.POST(req("POST", "http://test/api/staff/automation", { resource: "task", name: "Tidy", kind: "archive_stale_listings", config: { days: 365 }, cadence: "daily", hour: 9 }))).status).toBe(201);
    expect((await auto.POST(req("POST", "http://test/api/staff/automation", { resource: "task", name: "Tidy", kind: "archive_stale_listings", config: { days: 2 }, cadence: "daily" }))).status).toBe(400);
    expect((await autoOne.PATCH(req("PATCH", "http://test/x", { action: "disable" }), ctx)).status).toBe(200);
    expect((await autoOne.PATCH(req("PATCH", "http://test/x?resource=task", { action: "run" }), ctx)).status).toBe(200);
    expect((await autoOne.PATCH(req("PATCH", "http://test/x?resource=task", { action: "explode" }), ctx)).status).toBe(400);
    expect((await autoOne.DELETE(req("DELETE", "http://test/x"), ctx)).status).toBe(200);
    expect((await autoOne.PATCH(req("PATCH", "http://test/x", { action: "disable" }), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    expect(state.audits).toEqual(["staff.automation_rule_created", "staff.scheduled_task_created", "staff.automation_rule_disabled", "staff.scheduled_task_run_now", "staff.automation_rule_removed"]);
  });
  it("refuses a request from another site (CSRF)", async () => {
    state.staff = admin;
    const r = new Request("http://test/api/staff/automation", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: JSON.stringify(rule) });
    expect((await auto.POST(r)).status).toBe(403);
  });
});

describe("staff campaign routes", () => {
  it("need staff with campaign.manage", async () => {
    expect((await camp.GET(req("GET", "http://test/api/staff/campaigns"))).status).toBe(401);
    state.staff = support;
    expect((await camp.GET(req("GET", "http://test/api/staff/campaigns"))).status).toBe(403);
    expect((await camp.POST(req("POST", "http://test/api/staff/campaigns", campaign))).status).toBe(403);
    expect((await campOne.POST(req("POST", "http://test/x", { action: "send" }), ctx)).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("creates, previews the audience, sends, schedules and cancels with audit events", async () => {
    state.staff = admin;
    expect((await camp.POST(req("POST", "http://test/api/staff/campaigns", campaign))).status).toBe(201);
    const prev = await camp.POST(req("POST", "http://test/api/staff/campaigns", { ...campaign, action: "preview" }));
    expect(await prev.json()).toEqual({ audience: 7 });
    expect((await camp.POST(req("POST", "http://test/api/staff/campaigns", { ...campaign, subject: "" }))).status).toBe(400);
    expect((await campOne.POST(req("POST", "http://test/x", { action: "send" }), ctx)).status).toBe(200);
    expect((await campOne.POST(req("POST", "http://test/x", { action: "schedule", scheduledAt: "2026-11-06T00:00:00Z" }), ctx)).status).toBe(200);
    expect((await campOne.POST(req("POST", "http://test/x", { action: "schedule", scheduledAt: "2020-01-01T00:00:00Z" }), ctx)).status).toBe(400);
    expect((await campOne.POST(req("POST", "http://test/x", { action: "cancel" }), ctx)).status).toBe(200);
    expect((await campOne.POST(req("POST", "http://test/x", { action: "nuke" }), ctx)).status).toBe(400);
    expect(state.calls.filter(c => c[0] === "move").map(c => c[2])).toEqual(["sending", "scheduled", "cancelled"]);
    expect(state.audits).toEqual(["staff.campaign_created", "staff.campaign_send", "staff.campaign_schedule", "staff.campaign_cancel"]);
  });
});

describe("campaign tracking routes (public)", () => {
  const T = "a".repeat(48);
  it("answers an open pixel with a GIF for any token and records only well-formed tokens", async () => {
    const r = await open.GET(req("GET", "http://test/x"), { params: Promise.resolve({ token: T }) });
    expect(r.headers.get("content-type")).toBe("image/gif");
    await open.GET(req("GET", "http://test/x"), { params: Promise.resolve({ token: "bad token!" }) });
    expect(state.openTokens).toEqual([T]);
  });
  it("redirects a click only to the campaign's stored link, never to a request value", async () => {
    state.clickTarget = "https://owner.example/news";
    const r = await click.GET(req("GET", `http://test/x?u=https://evil.example`), { params: Promise.resolve({ token: T }) });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://owner.example/news");
    state.clickTarget = "/listings";
    expect((await click.GET(req("GET", "http://test/x"), { params: Promise.resolve({ token: T }) })).headers.get("location")).toBe("http://test/listings");
    state.clickTarget = null;
    expect((await click.GET(req("GET", "http://test/x"), { params: Promise.resolve({ token: T }) })).headers.get("location")).toBe("http://test/");
  });
});

describe("automation cron route", () => {
  const SECRET = "z".repeat(40);
  const call = (secret?: string) => cron.POST(new Request("http://test/api/internal/staff-automation/run", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
  afterEach(() => { delete process.env["STAFF_AUTOMATION_CRON_SECRET"]; });
  it("fails closed while the secret is unset or short and rejects a wrong one", async () => {
    expect((await call("x")).status).toBe(503);
    process.env["STAFF_AUTOMATION_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    process.env["STAFF_AUTOMATION_CRON_SECRET"] = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(SECRET + "x")).status).toBe(401);
    expect(state.tickCalls).toBe(0);
  });
  it("runs the tick with the right secret, and a 15-minute workflow calls it", async () => {
    process.env["STAFF_AUTOMATION_CRON_SECRET"] = SECRET;
    const res = await call(SECRET);
    expect(res.status).toBe(200);
    expect(state.tickCalls).toBe(1);
    const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "staff-automation.yml"), "utf8");
    expect(wf).toContain('cron: "*/15 * * * *"');
    expect(wf).toContain("/api/internal/staff-automation/run");
    expect(wf).toContain("STAFF_AUTOMATION_CRON_SECRET");
  });
});
