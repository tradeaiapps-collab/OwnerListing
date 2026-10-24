import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";
import { staffCan, type StaffRole } from "../src/domain/staff-access";
import { sectionsFor } from "../src/domain/staff-admin";

const state = vi.hoisted(() => ({
  staff: null as { id: string; role: string; permissions?: string[] } | null,
  actor: null as { userId: string; userType: string } | null,
  switches: [] as { enabled: boolean; reason: string }[],
  audits: [] as { eventType: string; payload: Record<string, unknown> }[],
  hits: 1 as number | undefined,
  engine: null as unknown,
  status: { reachable: true, model: "llama3.1:8b", modelInstalled: true } as Record<string, unknown>
}));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor,
  getStaff: async () => state.staff,
  getDb: () => ({ query: async () => ({ rows: [] }) }),
  getDeps: () => ({
    repo: { get: async (id: string) => (id === "L1" ? { listing: { id: "L1", ownerUserId: "owner-1", transactionType: "sale", propertyType: "house", title: "Home", suburb: "Paddington" } } : undefined) },
    appendAudit: async (e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); },
    newId: () => "id", now: () => "2026-10-25T00:00:00.000Z"
  })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); } }));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/ai-switch-db", () => ({
  aiSwitchOn: async () => state.switches.at(-1)?.enabled === true,
  aiSwitchHistory: async () => [...state.switches].reverse(),
  setAiSwitch: async (_db: unknown, _s: unknown, enabled: boolean, reason: string) => { state.switches.push({ enabled, reason }); }
}));
vi.mock("../src/server/ai", () => ({
  getAiEngine: async () => state.engine,
  engineForConfig: () => ({ status: async () => state.status })
}));

import * as aiRoute from "../app/api/staff/ai/route";
import * as testRoute from "../app/api/staff/ai/test/route";
import * as descRoute from "../app/api/listings/[id]/description-suggestion/route";

const ROLES: StaffRole[] = ["super_admin", "compliance", "accountant", "support", "technical", "reporting", "designer"];
const ENV = ["APP_URL", "AI_ENGINE", "AI_ENDPOINT", "AI_MODEL", "APP_MODE"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env["APP_URL"] = "http://test"; delete process.env["APP_MODE"];
  delete process.env["AI_ENGINE"]; delete process.env["AI_ENDPOINT"]; delete process.env["AI_MODEL"];
  state.staff = null; state.actor = null; state.switches = []; state.audits = []; state.hits = 1; state.engine = rulesOnlyEngine;
  state.status = { reachable: true, model: "llama3.1:8b", modelInstalled: true };
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const H = { "content-type": "application/json", origin: "http://test" };
const req = (method: string, body?: unknown, headers: Record<string, string> = H) =>
  new Request("http://test/x", { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const U = "00000000-0000-4000-8000-000000000001";
const ON = { enabled: true, reason: "Local PC test of Ollama" };
const listingCtx = { params: Promise.resolve({ id: "L1" }) };

describe("ai.engine_set and /staff/ai access", () => {
  it("the permission is sensitive and held only by super_admin among built-in roles", () => {
    for (const r of ROLES) expect(staffCan({ id: U, role: r }, "ai.engine_set"), r).toBe(r === "super_admin");
    expect(sectionsFor({ id: U, role: "super_admin" }).some(s => s.href === "/staff/ai")).toBe(true);
    expect(sectionsFor({ id: U, role: "technical" }).some(s => s.href === "/staff/ai")).toBe(false);
  });
  it("signed out = 401; every other role = 403; a custom role holding the permission is still refused", async () => {
    expect((await aiRoute.GET(req("GET"))).status).toBe(401);
    for (const r of ROLES.filter(x => x !== "super_admin")) {
      state.staff = { id: U, role: r };
      expect((await aiRoute.GET(req("GET"))).status, r).toBe(403);
      expect((await aiRoute.POST(req("POST", ON))).status, r).toBe(403);
      expect((await testRoute.POST(req("POST", {}))).status, r).toBe(403);
    }
    state.staff = { id: U, role: "custom_ai_ops", permissions: ["ai.engine_set"] };
    expect((await aiRoute.POST(req("POST", ON))).status).toBe(403);
    expect(state.switches).toEqual([]);
  });
  it("CSRF: a cross-origin or non-JSON POST is refused before anything changes", async () => {
    state.staff = { id: U, role: "super_admin" };
    expect((await aiRoute.POST(req("POST", ON, { "content-type": "application/json", origin: "http://evil" }))).status).toBe(403);
    expect((await aiRoute.POST(req("POST", ON, { "content-type": "text/plain", origin: "http://test" }))).status).toBe(403);
    expect((await testRoute.POST(req("POST", {}, { "content-type": "application/json" }))).status).toBe(403);
    expect(state.switches).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});

describe("/api/staff/ai switch", () => {
  beforeEach(() => { state.staff = { id: U, role: "super_admin" }; });
  it("is off by default and shows the server config problem", async () => {
    const v = await (await aiRoute.GET(req("GET"))).json();
    expect(v).toMatchObject({ enabled: false, configured: false, effective: false, configState: "off", history: [] });
  });
  it("needs a boolean and a reason; on and off add history rows and audit events", async () => {
    expect((await aiRoute.POST(req("POST", { enabled: "yes", reason: "Local PC test" }))).status).toBe(400);
    expect((await aiRoute.POST(req("POST", { enabled: true, reason: "short" }))).status).toBe(400);
    process.env["AI_ENGINE"] = "ollama";
    const on = await (await aiRoute.POST(req("POST", ON))).json();
    expect(on).toMatchObject({ enabled: true, configured: true, effective: true, model: "llama3.1:8b", endpoint: "http://127.0.0.1:11434" });
    await aiRoute.POST(req("POST", { enabled: false, reason: "Finished the PC test" }));
    expect(state.switches.map(s => s.enabled)).toEqual([true, false]);
    expect(state.audits.map(a => a.eventType)).toEqual(["ai.switched_on", "ai.switched_off"]);
  });
  it("switch on but no server config is not effective", async () => {
    const v = await (await aiRoute.POST(req("POST", ON))).json();
    expect(v).toMatchObject({ enabled: true, configured: false, effective: false });
  });
});

describe("/api/staff/ai/test", () => {
  beforeEach(() => { state.staff = { id: U, role: "super_admin" }; });
  it("not configured = 409, audited", async () => {
    const r = await testRoute.POST(req("POST", {}));
    expect(r.status).toBe(409);
    expect(state.audits[0]).toMatchObject({ eventType: "ai.connection_tested", payload: { outcome: "not_configured" } });
  });
  it("reports ok, model missing and unreachable, each audited", async () => {
    process.env["AI_ENGINE"] = "ollama";
    expect(await (await testRoute.POST(req("POST", {}))).json()).toMatchObject({ outcome: "ok", reachable: true, modelInstalled: true });
    state.status = { reachable: true, model: "llama3.1:8b", modelInstalled: false };
    expect((await (await testRoute.POST(req("POST", {}))).json()).outcome).toBe("model_missing");
    state.status = { reachable: false, model: "llama3.1:8b", modelInstalled: false, error: "network" };
    expect(await (await testRoute.POST(req("POST", {}))).json()).toMatchObject({ outcome: "unreachable", errorCode: "network" });
    expect(state.audits.map(a => a.payload["outcome"])).toEqual(["ok", "model_missing", "unreachable"]);
  });
  it("is rate limited and fails closed when the counter is unavailable", async () => {
    process.env["AI_ENGINE"] = "ollama";
    state.hits = 11;
    expect((await testRoute.POST(req("POST", {}))).status).toBe(429);
    state.hits = undefined;
    expect((await testRoute.POST(req("POST", {}))).status).toBe(429);
    expect(state.audits).toEqual([]);
  });
});

describe("POST /api/listings/[id]/description-suggestion", () => {
  const ready: AiEnginePort = { ...rulesOnlyEngine, info: () => ({ id: "t", kind: "self_hosted", version: "1" }), generate: async () => "A sunny family home in Paddington." };
  it("CSRF and sign-in are checked first; other people get 404", async () => {
    expect((await descRoute.POST(req("POST", {}, { "content-type": "application/json", origin: "http://evil" }), listingCtx)).status).toBe(403);
    expect((await descRoute.POST(req("POST", {}), listingCtx)).status).toBe(401);
    state.actor = { userId: "someone-else", userType: "owner" };
    expect((await descRoute.POST(req("POST", {}), listingCtx)).status).toBe(404);
  });
  it("AI off = unavailable (200), audited; nothing is saved", async () => {
    state.actor = { userId: "owner-1", userType: "owner" };
    const r = await descRoute.POST(req("POST", {}), listingCtx);
    expect(r.status).toBe(200);
    expect((await r.json()).state).toBe("unavailable");
    expect(state.audits[0]).toMatchObject({ eventType: "listing.ai_description_requested", payload: { aiState: "unavailable" } });
  });
  it("AI on = labelled suggestion; bad notes = 400; rate limited", async () => {
    state.actor = { userId: "owner-1", userType: "owner" };
    state.engine = ready;
    expect(await (await descRoute.POST(req("POST", { notes: "Big garden" }), listingCtx)).json())
      .toEqual({ state: "ready", text: "A sunny family home in Paddington.", label: "AI suggestion, check before publishing" });
    expect((await descRoute.POST(req("POST", { notes: "x".repeat(1001) }), listingCtx)).status).toBe(400);
    state.hits = 11;
    expect((await descRoute.POST(req("POST", {}), listingCtx)).status).toBe(429);
  });
});
