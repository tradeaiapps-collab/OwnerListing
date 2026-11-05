import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ actor: null as { userId: string; userType: string } | null, staff: null as StaffActor | null, calls: [] as unknown[][], out: { ok: true, value: {} } as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => state.actor, getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/settlement-db", () => {
  const rec = (name: string) => async (_db: unknown, ...a: unknown[]) => { state.calls.push([name, ...a]); return state.out; };
  return { listSettlements: async (_db: unknown, ...a: unknown[]) => { state.calls.push(["list", ...a]); return []; }, createSettlement: rec("create"), settlementView: rec("view"), updateMilestone: rec("milestone"), tickChecklistItem: rec("tick"),
    settlementPortfolio: async () => ({ rows: [], totals: { open: 0, stuck: 0, completed: 0, fellThrough: 0 }, byStage: {} }) };
});

import * as list from "../app/api/settlements/route";
import * as one from "../app/api/settlements/[id]/route";
import * as staff from "../app/api/staff/settlements/route";
process.env["APP_URL"] = "http://test";

const ID = "00000000-0000-4000-8000-000000000001";
const H = { "content-type": "application/json", origin: "http://test" };
const post = (route: { POST: unknown }, body: unknown, headers: Record<string, string> = H) =>
  (route.POST as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request("http://test/api/x", { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id: ID }) });
const get = (route: { GET: unknown }, id = ID) =>
  (route.GET as (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>)(new Request("http://test/api/x"), { params: Promise.resolve({ id }) });

describe("settlement routes", () => {
  beforeEach(() => { state.actor = null; state.staff = null; state.calls = []; state.out = { ok: true, value: {} }; });

  it("needs a session, a same-origin request and a real id", async () => {
    expect((await get(list)).status).toBe(401);
    expect((await get(one)).status).toBe(401);
    expect((await post(list, { offerId: ID })).status).toBe(401);
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await post(list, { offerId: ID }, { ...H, origin: "http://evil" })).status).toBe(403);
    expect((await get(one, "nope")).status).toBe(404);
    expect(state.calls).toEqual([]);
  });

  it("passes only the signed-in user; the side is never taken from the body", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    expect((await post(list, { offerId: ID, userId: "other", side: "buyer" })).status).toBe(201);
    await get(one);
    await post(one, { action: "tick", stage: "offer_accepted", role: "buyer", itemId: "buyer-0", done: true, userId: "other" });
    expect(state.calls).toEqual([
      ["create", "u1", ID], ["view", "u1", ID],
      ["tick", "u1", ID, { action: "tick", stage: "offer_accepted", role: "buyer", itemId: "buyer-0", done: true }]
    ]);
  });

  it("validates before touching the database and relays refusals", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    expect((await post(list, { offerId: "x" })).status).toBe(400);
    expect((await post(one, { action: "milestone", stage: "finance_approval", status: "blocked" })).status).toBe(400);
    expect(state.calls).toEqual([]);
    state.out = { ok: false, status: 403, error: "Only the owner or their agent can update the timeline." };
    expect((await post(one, { action: "milestone", stage: "deposit_received", status: "completed" })).status).toBe(403);
  });

  it("staff portfolio needs a staff session with a report permission", async () => {
    const req = () => (staff.GET as (r: Request) => Promise<Response>)(new Request("http://test/api/staff/settlements"));
    expect((await req()).status).toBe(401);
    state.staff = { id: "s1", role: "support", permissions: [] } as unknown as StaffActor;
    expect((await req()).status).toBe(403);
    state.staff = { id: "s1", role: "ops", permissions: ["report.sales"] } as unknown as StaffActor;
    expect((await req()).status).toBe(200);
  });
});
