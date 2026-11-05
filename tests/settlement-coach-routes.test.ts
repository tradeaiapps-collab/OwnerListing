import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ actor: null as { userId: string } | null, staff: null as StaffActor | null, calls: [] as unknown[][], out: { ok: true, value: {} } as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => state.actor, getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/settlement-coach-db", () => ({
  coachingView: async (_d: unknown, ...a: unknown[]) => { state.calls.push(["view", ...a]); return state.out; },
  decideSuggestion: async (_d: unknown, ...a: unknown[]) => { state.calls.push(["decide", ...a]); return state.out; },
  coachingStatsPg: async () => ({ byType: [], coached: { deals: 0, settled: 0, fellThrough: 0, avgDaysToSettle: null }, uncoached: { deals: 0, settled: 0, fellThrough: 0, avgDaysToSettle: null } })
}));
import * as coaching from "../app/api/settlements/[id]/coaching/route";
import * as staffRoute from "../app/api/staff/negotiation-coaching/route";
process.env["APP_URL"] = "http://test";

const ID = "00000000-0000-4000-8000-000000000001";
const H = { "content-type": "application/json", origin: "http://test" };
type Fn = (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
const get = (id = ID) => (coaching.GET as unknown as Fn)(new Request("http://test/x"), { params: Promise.resolve({ id }) });
const post = (body: unknown, headers: Record<string, string> = H, id = ID) => (coaching.POST as unknown as Fn)(new Request("http://test/x", { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("settlement coaching routes", () => {
  beforeEach(() => { state.actor = null; state.staff = null; state.calls = []; state.out = { ok: true, value: {} }; });
  it("needs a session, same origin and a real id", async () => {
    expect((await get()).status).toBe(401);
    expect((await post({ suggestion: "deposit_low", decision: "use" })).status).toBe(401);
    state.actor = { userId: "u1" };
    expect((await post({ suggestion: "deposit_low", decision: "use" }, { ...H, origin: "http://evil" })).status).toBe(403);
    expect((await get("nope")).status).toBe(404);
    expect(state.calls).toEqual([]);
  });
  it("passes only the signed-in user and validates the body", async () => {
    state.actor = { userId: "u1" };
    expect((await post({ suggestion: "bogus", decision: "use" })).status).toBe(400);
    expect((await post({ suggestion: "deposit_low", decision: "maybe" })).status).toBe(400);
    await get();
    await post({ suggestion: "deposit_low", decision: "dismiss", userId: "other", side: "buyer" });
    expect(state.calls).toEqual([["view", "u1", ID], ["decide", "u1", ID, "deposit_low", false]]);
  });
  it("relays refusals", async () => {
    state.actor = { userId: "u1" };
    state.out = { ok: false, status: 404, error: "Settlement not found." };
    expect((await get()).status).toBe(404);
  });
  it("staff stats need a staff session", async () => {
    expect(((await (staffRoute.GET as unknown as (r: Request) => Promise<Response>)(new Request("http://test/x")))).status).toBe(401);
  });
});
