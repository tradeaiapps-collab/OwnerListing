import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ actor: null as { userId: string } | null, staff: null as StaffActor | null, calls: [] as unknown[][], out: { ok: true, value: { score: 70 } } as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => ({}), getActor: async () => state.actor, getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/settlement-risk-db", () => ({
  riskDashboard: async () => ({ rows: [], alerts: [], totals: { open: 0, high: 0, medium: 0, low: 0 }, history: { fellThrough: 0, settled: 0, ratePercent: null, byReason: {} }, rulesVersion: "t" }),
  staffRiskDetail: async (_d: unknown, id: string) => { state.calls.push(["staff", id]); return state.out; },
  partyRiskDetail: async (_d: unknown, u: string, id: string) => { state.calls.push(["party", u, id]); return state.out; }
}));

import * as dash from "../app/api/staff/settlements/risk/route";
import * as staffOne from "../app/api/staff/settlements/[id]/risk/route";
import * as party from "../app/api/settlements/[id]/risk/route";

const ID = "00000000-0000-4000-8000-000000000001";
type Ctx = { params: Promise<{ id: string }> };
const call = (route: { GET: unknown }, id = ID) => (route.GET as (r: Request, c: Ctx) => Promise<Response>)(new Request("http://test/api/x"), { params: Promise.resolve({ id }) });

describe("settlement risk routes", () => {
  beforeEach(() => { state.actor = null; state.staff = null; state.calls = []; state.out = { ok: true, value: { score: 70 } }; });

  it("the staff dashboard and detail need a staff session with a report permission", async () => {
    for (const route of [dash, staffOne]) {
      expect((await call(route)).status).toBe(401);
      state.staff = { id: "s1", role: "support", permissions: [] } as unknown as StaffActor;
      expect((await call(route)).status).toBe(403);
      state.staff = { id: "s1", role: "ops", permissions: ["report.operations"] } as unknown as StaffActor;
      expect((await call(route)).status).toBe(200);
      state.staff = null;
    }
  });

  it("staff detail rejects a bad id before the database", async () => {
    state.staff = { id: "s1", role: "ops", permissions: ["report.sales"] } as unknown as StaffActor;
    expect((await call(staffOne, "nope")).status).toBe(404);
    expect(state.calls).toEqual([]);
    expect((await call(staffOne)).headers.get("cache-control")).toBe("no-store");
  });

  it("the party route needs a session, a real id, and relays refusals (the buyer's 403)", async () => {
    expect((await call(party)).status).toBe(401);
    state.actor = { userId: "u1" };
    expect((await call(party, "nope")).status).toBe(404);
    expect((await call(party)).status).toBe(200);
    expect(state.calls).toEqual([["party", "u1", ID]]);
    state.out = { ok: false, status: 403, error: "Risk advice is for the owner and their agent." };
    expect((await call(party)).status).toBe(403);
  });
});
