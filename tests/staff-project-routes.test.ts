import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, calls: [] as unknown[][], audits: [] as string[] }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/staff-project-db", () => {
  const rec = (name: string, out: unknown) => async (_db: unknown, ...a: unknown[]) => { state.calls.push([name, ...a]); return out; };
  return {
    listProjects: rec("list", { projects: [], escalatedNow: ["p1"] }), listPeople: async () => [], getSettings: async () => ({ highBudgetCents: 5_000_000 }),
    setHighBudget: rec("threshold", undefined), createProject: rec("create", { ok: true, value: { id: "p-new", risks: [] } }),
    projectDetail: rec("detail", { ok: true, value: { id: "x" } }), decide: rec("decide", { ok: true, value: { status: "active" } }), act: rec("act", { ok: true, value: { ok: true } })
  };
});

import * as list from "../app/api/staff/projects/route";
import * as one from "../app/api/staff/projects/[id]/route";
process.env["APP_URL"] = "http://test";

const ID = "00000000-0000-4000-8000-000000000001";
const H = { "content-type": "application/json", origin: "http://test" };
const proposal = { title: "Reduce fallthrough", description: "Cut sales that fall through.", goal: "Fewer fallen sales", ownerId: ID, startDate: "2026-11-01", endDate: "2026-12-30", budgetDollars: 10, storyPoints: 5, estimatedHours: 40, estimatedDays: 10, teamSize: 2,
  checklist: { scope_clear: true, dependencies_identified: true, resources_available: true, budget_justified: true, effort_estimated: true } };
const post = (route: { POST: unknown }, body: unknown, headers: Record<string, string> = H) =>
  (route.POST as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request("http://test/api/x", { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) });
const get = (route: { GET: unknown }, id = ID) => (route.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request("http://test/api/x"), { params: Promise.resolve({ id }) });
// Built-in roles hold no project permission; a custom role (or super admin) is given them. The permissions are what the gate reads.
const PERMS: Record<string, StaffActor["permissions"]> = {
  technical: ["project.manage", "project.tech_lead", "config.edit"], accountant: ["project.review"], reporting: ["project.manage"], designer: ["theme.edit"]
};
const as = (role: string): StaffActor => ({ id: "s1", role: `custom_${role}`, permissions: PERMS[role] ?? [] });

describe("project routes", () => {
  beforeEach(() => { state.staff = null; state.calls = []; state.audits = []; });

  it("needs staff, a same-origin request and a real id", async () => {
    expect((await get(list)).status).toBe(401);
    expect((await post(list, proposal)).status).toBe(401);
    state.staff = as("technical");
    expect((await post(list, proposal, { ...H, origin: "http://evil" })).status).toBe(403);
    expect((await get(one, "nope")).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("keeps roles without a project permission out", async () => {
    state.staff = as("designer");
    expect((await get(list)).status).toBe(403);
    expect((await get(one)).status).toBe(403);
  });

  it("lists, audits the escalation, and tells the screen what the role can do", async () => {
    state.staff = as("accountant");
    const r = await get(list);
    expect(r.status).toBe(200);
    expect((await r.json()).can).toEqual({ propose: false, configure: false });
    expect(state.audits).toEqual(["staff.project_escalated"]);
  });

  it("only project.manage proposes; the proposer is the signed-in staff member and the body is validated", async () => {
    state.staff = as("accountant");
    expect((await post(list, proposal)).status).toBe(403);
    state.staff = as("technical");
    expect((await post(list, { ...proposal, storyPoints: 4 })).status).toBe(400);
    expect((await post(list, { ...proposal, createdBy: "someone" })).status).toBe(201);
    expect(state.calls[0]![1]).toBe("s1");
    expect(state.audits).toContain("staff.project_proposed");
  });

  it("changes the budget threshold only with config.edit", async () => {
    state.staff = as("reporting");
    expect((await post(list, { action: "set_threshold", highBudgetDollars: 1000 })).status).toBe(403);
    state.staff = as("technical");
    expect((await post(list, { action: "set_threshold", highBudgetDollars: 0 })).status).toBe(400);
    expect((await post(list, { action: "set_threshold", highBudgetDollars: 1000 })).status).toBe(200);
    expect(state.calls).toEqual([["threshold", "s1", 100_000]]);
  });

  it("decisions take the permissions from the role, never the body", async () => {
    state.staff = as("accountant");
    expect((await post(one, { action: "decide", as: "stakeholder", decision: "approved", comments: "Finance is happy.", canTechLead: true })).status).toBe(200);
    expect(state.calls[0]![1]).toEqual({ id: "s1", canTechLead: false, canReview: true });
    expect((await post(one, { action: "decide", as: "stakeholder", decision: "approved", comments: "short" })).status).toBe(400);
    expect(state.audits).toEqual(["staff.project_decision"]);
  });

  it("other actions need project.manage", async () => {
    state.staff = as("accountant");
    expect((await post(one, { action: "pr_link", prNumber: 5, title: "T" })).status).toBe(403);
    state.staff = as("technical");
    expect((await post(one, { action: "pr_link", prNumber: 5, title: "T" })).status).toBe(200);
    expect(state.audits).toEqual(["staff.project_pr_link"]);
  });
});
