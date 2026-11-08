import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/domain/listing-service";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ actor: null as Actor | null, staff: null as StaffActor | null, calls: [] as [string, ...unknown[]][], out: { ok: true, value: {} } as unknown }));
vi.mock("../src/server/context", () => ({
  getDb: () => ({ query: async () => ({ rows: [] }) }), getActor: async () => state.actor, getStaff: async () => state.staff
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/commission-db", () => {
  const rec = (name: string) => async (...a: unknown[]) => { state.calls.push([name, ...a.slice(1)]); return state.out; };
  return {
    agentCommissions: async () => ({ deals: [], payouts: [] }), agentDisplayName: async () => "Jane Citizen",
    allCommissions: async () => ({ deals: [], payouts: [] }), listAgents: async () => [], getDeal: async () => null,
    createDeal: rec("create"), overrideDeal: rec("override"), setDealStatus: rec("status"), replaceSchedule: rec("schedule"), markPayoutPaid: rec("paid")
  };
});

import * as agentRoute from "../app/api/agent/commissions/route";
import * as staffList from "../app/api/staff/commissions/route";
import * as staffDeal from "../app/api/staff/commissions/[id]/route";
import * as staffPayout from "../app/api/staff/commissions/payouts/[id]/route";
process.env["APP_URL"] = "http://test";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const accountant: StaffActor = { id: U(1), role: "accountant" };
const support: StaffActor = { id: U(2), role: "support" };
const ctx = (id = U(100)) => ({ params: Promise.resolve({ id }) });
const H = { "content-type": "application/json", origin: "http://test" };
const post = (route: { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, body: unknown, id?: string, headers: Record<string, string> = H) =>
  route.POST(new Request("http://test/api/staff/commissions", { method: "POST", headers, body: JSON.stringify(body) }), ctx(id));
const get = (route: { GET: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, qs = "") => route.GET(new Request(`http://test/api/x${qs}`), ctx());

describe("agent commissions route", () => {
  beforeEach(() => { state.actor = null; });
  it("needs a signed-in agent", async () => {
    expect((await get(agentRoute)).status).toBe(401);
    state.actor = { userId: U(5), userType: "owner" };
    expect((await get(agentRoute)).status).toBe(403);
  });
  it("returns the agent's data with Elena's summary, and rejects a bad month", async () => {
    state.actor = { userId: U(5), userType: "agent" };
    const r = await get(agentRoute);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ deals: [], elena: { text: expect.stringContaining("Hi Jane") }, forecast: { months: expect.any(Array) } });
    expect((await get(agentRoute, "?month=2026-13")).status).toBe(400);
    expect((await get(agentRoute, "?month=../x")).status).toBe(400);
  });
  it("serves the statement as a CSV download", async () => {
    state.actor = { userId: U(5), userType: "agent" };
    const r = await get(agentRoute, "?month=2026-10&format=csv");
    expect(r.headers.get("content-type")).toContain("text/csv");
    expect(r.headers.get("content-disposition")).toContain("commission-statement-2026-10.csv");
    expect(await r.text()).toContain("Date,Deal,Status");
  });
});

describe("staff commission routes", () => {
  beforeEach(() => { state.staff = null; state.calls = []; state.out = { ok: true, value: {} }; });
  const deal = { agentUserId: U(9), title: "12 Reef St", salePriceCents: 100_000_000, terms: { kind: "percentage", bps: 200 }, dealDate: "2026-10-01" };

  it("refuse without a session, across origins, and without the permission", async () => {
    expect((await get(staffList)).status).toBe(401);
    expect((await post(staffList, deal)).status).toBe(401);
    state.staff = accountant;
    expect((await post(staffList, deal, undefined, { ...H, origin: "http://evil" })).status).toBe(403);
    state.staff = support;
    expect((await get(staffList)).status).toBe(403);
    expect((await post(staffList, deal)).status).toBe(403);
    expect((await post(staffDeal, { action: "earned" })).status).toBe(403);
    expect((await post(staffPayout, {})).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("lists with analytics for an accountant and rejects odd filters", async () => {
    state.staff = accountant;
    const r = await get(staffList);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ analytics: { byMonth: expect.any(Array) }, agents: [] });
    expect((await get(staffList, "?status=bogus")).status).toBe(400);
    expect((await get(staffList, "?agentId=nope")).status).toBe(400);
  });

  it("creates a deal only with valid input", async () => {
    state.staff = accountant;
    state.out = { ok: true, value: { id: U(7) } };
    expect((await post(staffList, { ...deal, salePriceCents: 0 })).status).toBe(400);
    expect((await post(staffList, { ...deal, terms: { kind: "percentage", bps: 99_999 } })).status).toBe(400);
    expect(state.calls).toEqual([]);
    const ok = await post(staffList, deal);
    expect(ok.status).toBe(201);
    expect(state.calls[0]![0]).toBe("create");
  });

  it("overrides and cancellations need a reason; unknown actions and ids are refused", async () => {
    state.staff = accountant;
    expect((await post(staffDeal, { action: "override", overrideCents: 5, reason: "no" })).status).toBe(400);
    expect((await post(staffDeal, { action: "cancel", reason: "short" })).status).toBe(400);
    expect((await post(staffDeal, { action: "explode" })).status).toBe(400);
    expect((await post(staffDeal, { action: "earned" }, "not-a-uuid")).status).toBe(404);
    expect(state.calls).toEqual([]);
    expect((await post(staffDeal, { action: "override", overrideCents: 5, reason: "Agreed with the owner in writing" })).status).toBe(200);
    expect((await post(staffDeal, { action: "cancel", reason: "Sale fell through at finance" })).status).toBe(200);
    expect((await post(staffDeal, { action: "earned" })).status).toBe(200);
    expect((await post(staffDeal, { action: "schedule", payments: [{ dueDate: "2026-12-01", amountCents: 100 }] })).status).toBe(200);
    expect(state.calls.map(c => c[0])).toEqual(["override", "status", "status", "schedule"]);
  });

  it("passes database refusals back with their status", async () => {
    state.staff = accountant;
    state.out = { ok: false, status: 409, error: "Mark the deal earned before recording a payment." };
    const r = await post(staffPayout, { reference: "EFT 1" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "Mark the deal earned before recording a payment." });
  });

  it("limits the payment reference to plain text", async () => {
    state.staff = accountant;
    expect((await post(staffPayout, { reference: "<script>" })).status).toBe(400);
    expect((await post(staffPayout, { reference: "x".repeat(101) })).status).toBe(400);
    expect((await post(staffPayout, {}, "bad")).status).toBe(404);
  });
});
