import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({ staff: null as null | { id: string; role: string }, actor: null as null | { userId: string; userType: string }, calls: [] as unknown[][] }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getStaff: async () => state.staff, getActor: async () => state.actor, getDeps: () => ({}) }));
vi.mock("../src/server/csrf", () => ({ csrfGuard: () => null }));
vi.mock("../src/server/ad-lead-db", () => ({
  listAgents: async () => [{ id: A, name: "Ann" }],
  listLeads: async (...a: unknown[]) => { state.calls.push(["list", a[1]]); return { leads: [], total: 0 }; },
  setAgentLeadStatus: async (...a: unknown[]) => { state.calls.push(["status", a[1], a[2], a[3], a[4]]); return a[2] === "nope" ? { ok: false, error: "Lead not found." } : { ok: true }; }
}));
vi.mock("../src/server/ad-lead-routing-db", () => ({
  listRules: async () => [], createRule: async (...a: unknown[]) => { state.calls.push(["create", a[2]]); return { ok: true, id: "r1" }; },
  setRule: async (...a: unknown[]) => { state.calls.push(["rule", a[2], a[3]]); return a[2] !== "missing"; }
}));
import { GET as rulesGet, POST as rulesPost } from "../app/api/staff/ad-lead-rules/route";
import { POST as ruleAct } from "../app/api/staff/ad-lead-rules/[id]/route";
import { GET as agentGet } from "../app/api/agent/ad-leads/route";
import { POST as agentPost } from "../app/api/agent/ad-leads/[id]/route";

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => { state.staff = null; state.actor = null; state.calls = []; });

describe("staff lead rules", () => {
  it("need a signed-in staff member with ad_leads.manage", async () => {
    expect((await rulesGet(new Request("http://t/api/staff/ad-lead-rules"))).status).toBe(401);
    state.staff = { id: "s", role: "support" };
    expect((await rulesGet(new Request("http://t/api/staff/ad-lead-rules"))).status).toBe(403);
    expect((await rulesPost(new Request("http://t/api/staff/ad-lead-rules", json({})))).status).toBe(403);
  });
  it("validate and create a rule, and pause or delete one", async () => {
    state.staff = { id: "s", role: "super_admin" };
    expect((await rulesGet(new Request("http://t/api/staff/ad-lead-rules"))).status).toBe(200);
    expect((await rulesPost(new Request("http://t/api/staff/ad-lead-rules", json({ label: "x" })))).status).toBe(400);
    expect((await rulesPost(new Request("http://t/api/staff/ad-lead-rules", json({ label: "West", postcodes: ["4064"], agentUserIds: [A] })))).status).toBe(201);
    expect((await ruleAct(new Request("http://t/x", json({ action: "boom" })), ctx("r1"))).status).toBe(400);
    expect((await ruleAct(new Request("http://t/x", json({ action: "disable" })), ctx("r1"))).status).toBe(200);
    expect((await ruleAct(new Request("http://t/x", json({ action: "delete" })), ctx("missing"))).status).toBe(404);
  });
});

describe("agent leads", () => {
  it("need an agent account", async () => {
    expect((await agentGet(new Request("http://t/api/agent/ad-leads"))).status).toBe(401);
    state.actor = { userId: A, userType: "owner" };
    expect((await agentGet(new Request("http://t/api/agent/ad-leads"))).status).toBe(403);
    expect((await agentPost(new Request("http://t/x", json({ status: "contacted" })), ctx("l1"))).status).toBe(403);
  });
  it("list only the agent's own non-test leads, whatever is asked", async () => {
    state.actor = { userId: A, userType: "agent" };
    expect((await agentGet(new Request("http://t/api/agent/ad-leads?status=bogus"))).status).toBe(400);
    expect((await agentGet(new Request("http://t/api/agent/ad-leads?status=new&agentId=someone-else"))).status).toBe(200);
    expect(state.calls[0]![1]).toMatchObject({ agentId: A, excludeTests: true, status: "new" });
  });
  it("update status for their own lead, and answer 404 for one that is not theirs", async () => {
    state.actor = { userId: A, userType: "agent" };
    expect((await agentPost(new Request("http://t/x", json({ status: "weird" })), ctx("l1"))).status).toBe(400);
    expect((await agentPost(new Request("http://t/x", json({ status: "lost", reason: " no answer " })), ctx("l1"))).status).toBe(200);
    expect(state.calls[0]).toEqual(["status", A, "l1", "lost", "no answer"]);
    expect((await agentPost(new Request("http://t/x", json({ status: "contacted" })), ctx("nope"))).status).toBe(404);
  });
});
