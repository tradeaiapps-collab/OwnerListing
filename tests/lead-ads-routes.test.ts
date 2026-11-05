import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  staff: null as null | { id: string; role: string }, ingested: [] as unknown[], metaSource: null as unknown, googleOk: true, lastKey: "", graphFail: false,
  calls: [] as unknown[][]
}));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getStaff: async () => state.staff, getActor: async () => null, getDeps: () => ({}) }));
vi.mock("../src/server/csrf", () => ({ csrfGuard: () => null }));
vi.mock("../src/server/lead-db", () => ({
  sourceForMetaPage: async (_d: unknown, page: string) => (page === "P1" ? state.metaSource : null),
  sourceForGoogle: async (_d: unknown, _id: string, key: string) => { state.lastKey = key; return state.googleOk && key === "good-key" ? { id: "s1" } : null; },
  ingestLead: async (_d: unknown, _s: unknown, lead: unknown) => { state.ingested.push(lead); return { created: true, leadId: "l1", followup: "none" }; },
  listLeads: async () => ({ leads: [], total: 0 }), sourceReports: async () => [], listAgents: async () => [],
  createSource: async () => ({ ok: true, id: "new", webhookKey: "k" }),
  getSource: async (_d: unknown, id: string) => (id === "s1" ? { id: "s1", provider: "google" } : null),
  updateSource: async (...a: unknown[]) => { state.calls.push(["update", ...a.slice(2, 4)]); return { ok: true }; },
  rotateGoogleKey: async () => "newkey", recordSpend: async (...a: unknown[]) => { state.calls.push(["spend", a[3]]); return true; },
  assignLead: async (...a: unknown[]) => { state.calls.push(["assign", a[2], a[3]]); return { ok: true }; },
  setLeadStatus: async (...a: unknown[]) => { state.calls.push(["status", a[3], a[4]]); return (a[4] === "boom" ? { ok: false, error: "x" } : { ok: true }); }
}));
import { GET as metaGet, POST as metaPost } from "../app/api/webhooks/leads/meta/route";
import { POST as googlePost } from "../app/api/webhooks/leads/google/[id]/route";
import { GET as staffGet } from "../app/api/staff/leads/route";
import { POST as leadPost } from "../app/api/staff/leads/[id]/route";
import { POST as sourcePost } from "../app/api/staff/lead-sources/route";
import { POST as sourceAct } from "../app/api/staff/lead-sources/[id]/route";

const ENV = { META_APP_SECRET: "appsecret", META_WEBHOOK_VERIFY_TOKEN: "verify-me", META_PAGE_ACCESS_TOKEN: "pagetoken" };
const setEnv = () => Object.assign(process.env, ENV);
const sign = (raw: string, secret = ENV.META_APP_SECRET) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const body = (pageId = "P1") => JSON.stringify({ object: "page", entry: [{ id: pageId, changes: [{ field: "leadgen", value: { leadgen_id: "L1", page_id: pageId, form_id: "F" } }] }] });
const post = (raw: string, sig?: string) => metaPost(new Request("http://test/api/webhooks/leads/meta", { method: "POST", headers: sig ? { "x-hub-signature-256": sig } : {}, body: raw }));
const graph = (fail = false) => vi.fn(async () => (fail ? new Response("no", { status: 500 }) : new Response(JSON.stringify({ id: "L1", field_data: [{ name: "email", values: ["a@b.com"] }, { name: "full_name", values: ["Ann"] }] }), { status: 200 })));

beforeEach(() => { state.ingested = []; state.metaSource = { id: "s1" }; state.googleOk = true; state.calls = []; });
afterEach(() => { for (const k of Object.keys(ENV)) delete process.env[k]; state.staff = null; vi.unstubAllGlobals(); });

describe("Meta webhook", () => {
  it("fails closed with 503 until all three settings exist", async () => {
    expect((await post(body(), sign(body()))).status).toBe(503);
    expect((await metaGet(new Request("http://test/x?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1"))).status).toBe(503);
  });
  it("answers the subscription check only with the right token", async () => {
    setEnv();
    const q = (t: string) => metaGet(new Request(`http://test/x?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=12345`));
    const ok = await q("verify-me");
    expect([ok.status, await ok.text()]).toEqual([200, "12345"]);
    expect((await q("nope")).status).toBe(403);
    expect((await metaGet(new Request("http://test/x?hub.mode=subscribe&hub.challenge=1"))).status).toBe(403);
  });
  it("refuses a missing or wrong signature and stores nothing", async () => {
    setEnv();
    const f = graph(); vi.stubGlobal("fetch", f);
    expect((await post(body())).status).toBe(401);
    expect((await post(body(), sign(body(), "other"))).status).toBe(401);
    expect((await post(body(), sign(body() + " "))).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
    expect(state.ingested).toEqual([]);
  });
  it("fetches the lead with the Page token and stores it", async () => {
    setEnv();
    const f = graph(); vi.stubGlobal("fetch", f);
    const r = await post(body(), sign(body()));
    expect([r.status, await r.json()]).toEqual([200, { created: 1, skipped: 0, failed: 0 }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("graph.facebook.com/");
    expect(url).not.toContain("pagetoken");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer pagetoken");
    expect(state.ingested[0]).toMatchObject({ externalId: "L1", email: "a@b.com", name: "Ann" });
  });
  it("acknowledges a Page that is not connected and asks Meta to retry when the lead cannot be fetched", async () => {
    setEnv();
    vi.stubGlobal("fetch", graph());
    const other = await post(body("P2"), sign(body("P2")));
    expect([other.status, await other.json()]).toEqual([200, { created: 0, skipped: 1, failed: 0 }]);
    vi.stubGlobal("fetch", graph(true));
    expect((await post(body(), sign(body()))).status).toBe(502);
    expect(state.ingested).toEqual([]);
  });
});

describe("Google webhook", () => {
  const g = (b: unknown, id = "s1") => googlePost(new Request("http://test/x", { method: "POST", body: typeof b === "string" ? b : JSON.stringify(b) }), { params: Promise.resolve({ id }) });
  const lead = (key: string) => ({ lead_id: "g1", google_key: key, user_column_data: [{ column_id: "EMAIL", string_value: "s@x.com" }] });
  it("needs the source's key; a wrong key, wrong id and paused source all answer 401", async () => {
    expect((await g(lead("bad"))).status).toBe(401);
    expect((await g({ lead_id: "g1", user_column_data: [] })).status).toBe(401);
    state.googleOk = false;
    expect((await g(lead("good-key"))).status).toBe(401);
    expect(state.ingested).toEqual([]);
  });
  it("stores a valid lead, rejects unreadable JSON and a form with no contact", async () => {
    const ok = await g(lead("good-key"));
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, created: true }]);
    expect(state.ingested[0]).toMatchObject({ externalId: "g1", email: "s@x.com" });
    expect((await g("{nope")).status).toBe(400);
    expect((await g({ lead_id: "g2", google_key: "good-key", user_column_data: [{ column_id: "FULL_NAME", string_value: "X" }] })).status).toBe(400);
    expect((await g(" ".repeat(300 * 1024))).status).toBe(413);
  });
});

describe("staff routes", () => {
  const json = (url: string, b: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  const lp = (b: unknown) => leadPost(json("http://test/l", b), { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) });
  const sp = (b: unknown, id = "s1") => sourceAct(json("http://test/s", b), { params: Promise.resolve({ id }) });
  it("need staff with leads.manage on every route", async () => {
    const all = async () => [(await staffGet(new Request("http://test/api/staff/leads"))).status, (await lp({ action: "status", status: "new" })).status, (await sourcePost(json("http://test/s", {}))).status, (await sp({ action: "pause" })).status];
    expect(await all()).toEqual([401, 401, 401, 401]);
    for (const role of ["support", "compliance", "accountant", "technical", "reporting", "designer"]) { state.staff = { id: "s", role }; expect(await all()).toEqual([403, 403, 403, 403]); }
    state.staff = { id: "s", role: "super_admin" };
    expect((await staffGet(new Request("http://test/api/staff/leads"))).status).toBe(200);
  });
  it("validates lead actions", async () => {
    state.staff = { id: "s", role: "super_admin" };
    expect((await lp({ action: "assign", agentId: "nope" })).status).toBe(400);
    expect((await lp({ action: "assign", agentId: null })).status).toBe(200);
    expect((await lp({ action: "status", status: "won" })).status).toBe(400);
    expect((await lp({ action: "status", status: "lost", reason: "  gone  " })).status).toBe(200);
    expect(state.calls).toContainEqual(["status", "lost", "gone"]);
    expect((await lp({ action: "delete" })).status).toBe(400);
  });
  it("validates source actions and shows a rotated key once", async () => {
    state.staff = { id: "s", role: "super_admin" };
    expect((await sp({ action: "pause" }, "zzz")).status).toBe(404);
    expect((await sp({ action: "followup", mode: "blast" })).status).toBe(400);
    expect((await sp({ action: "followup", mode: "matches" })).status).toBe(200);
    expect((await sp({ action: "agent", agentId: "x" })).status).toBe(400);
    expect(await (await sp({ action: "rotate_key" })).json()).toEqual({ webhookKey: "newkey" });
    expect((await sp({ action: "spend", rows: [{ day: "2026-11-05", spend: -5 }] })).status).toBe(400);
    expect((await sp({ action: "spend", rows: [{ day: "2026-11-05", spend: 5 }] })).status).toBe(200);
    expect((await sourcePost(json("http://test/s", { provider: "meta", label: "Page", accountRef: "12345678" }))).status).toBe(201);
    expect((await sourcePost(json("http://test/s", { provider: "meta", label: "P", accountRef: "x" }))).status).toBe(400);
  });
});
