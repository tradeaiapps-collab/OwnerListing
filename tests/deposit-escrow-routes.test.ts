import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, calls: [] as [string, ...unknown[]][], out: { ok: true, value: {} } as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => ({ query: async () => ({ rows: [] }) }), getActor: async () => null, getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/deposit-escrow-db", () => {
  const rec = (name: string) => async (...a: unknown[]) => { state.calls.push([name, ...a.slice(2)]); return state.out; };
  return {
    overview: async () => ({ holdings: [], movements: [], releases: [], acceptedWithout: [], accounts: [] }), pendingReleases: async () => [],
    getHolding: async () => null, accountLedger: async () => ({ lines: [], movements: [], holdings: [] }),
    createHolding: rec("create"), recordReceipt: rec("receipt"), requestRelease: rec("request"), cancelHolding: rec("cancel"),
    decideRelease: rec("decide"), importStatement: rec("import"), matchLine: rec("match"), receiptFromLine: rec("lineReceipt")
  };
});

vi.mock("../src/server/sale-fall-through-db", () => {
  const rec = (name: string) => async (...a: unknown[]) => { state.calls.push([name, ...a.slice(2)]); return state.out; };
  return { requestCasePayout: rec("casePayout"), resolveDispute: rec("caseResolve") };
});

import * as list from "../app/api/staff/escrow/route";
import * as one from "../app/api/staff/escrow/[id]/route";
import * as decide from "../app/api/staff/escrow/releases/[id]/route";
import * as account from "../app/api/staff/escrow/accounts/[id]/route";
import * as lineRoute from "../app/api/staff/escrow/lines/[id]/route";
process.env["APP_URL"] = "http://test";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const compliance: StaffActor = { id: U(1), role: "compliance" };
const accountant: StaffActor = { id: U(2), role: "accountant" };
const support: StaffActor = { id: U(3), role: "support" };
const H = { "content-type": "application/json", origin: "http://test" };
type Route = { POST: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> };
const post = (route: Route, body: unknown, id = U(100), headers: Record<string, string> = H) =>
  route.POST(new Request("http://test/api/staff/escrow", { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const get = (route: { GET: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response> }, id = U(100)) =>
  route.GET(new Request("http://test/api/staff/escrow"), { params: Promise.resolve({ id }) });

describe("deposit escrow routes", () => {
  beforeEach(() => { state.staff = null; state.calls = []; state.out = { ok: true, value: {} }; });

  it("refuse without a session, across origins, and without the permission", async () => {
    expect((await get(list)).status).toBe(401);
    expect((await post(list as unknown as Route, { offerId: U(5) })).status).toBe(401);
    state.staff = compliance;
    expect((await post(list as unknown as Route, { offerId: U(5) }, U(100), { ...H, origin: "http://evil" })).status).toBe(403);
    state.staff = support;
    expect((await get(list)).status).toBe(403);
    expect((await post(one, { action: "cancel", reason: "Opened in error, wrong offer" })).status).toBe(403);
    expect((await post(lineRoute, { action: "match", movementId: U(6) })).status).toBe(403);
    expect((await get(account)).status).toBe(403);
    state.staff = accountant; // can record and reconcile, but never approve a payout
    expect((await post(decide, { outcome: "approve", reason: "Settlement confirmed today" })).status).toBe(403);
    expect(state.calls).toEqual([]);
  });

  it("tells the screen what the role may do", async () => {
    state.staff = accountant;
    expect(await (await get(list)).json()).toMatchObject({ me: U(2), can: { manage: true, approve: false } });
    state.staff = compliance;
    expect(await (await get(list)).json()).toMatchObject({ can: { manage: true, approve: true } });
  });

  it("validates before calling the database", async () => {
    state.staff = accountant;
    expect((await post(list as unknown as Route, { offerId: "nope" })).status).toBe(400);
    expect((await post(one, { action: "receipt", amountCents: -1, receivedOn: "2026-11-01" })).status).toBe(400);
    expect((await post(one, { action: "request", kind: "release", amountCents: 100, reason: "Settled per solicitor" })).status).toBe(400);
    expect((await post(one, { action: "cancel", reason: "no" })).status).toBe(400);
    expect((await post(one, { action: "explode" })).status).toBe(400);
    expect((await post(one, { action: "receipt" }, "not-a-uuid")).status).toBe(404);
    expect((await post(lineRoute, { action: "match", movementId: "x" })).status).toBe(400);
    expect((await post(lineRoute, { action: "other" })).status).toBe(400);
    expect((await post(account, { csv: "" })).status).toBe(400);
    expect((await post(account, { csv: "x".repeat(1_000_001) })).status).toBe(413);
    expect(state.calls).toEqual([]);
  });

  it("passes valid actions through", async () => {
    state.staff = accountant;
    expect((await post(list as unknown as Route, { offerId: U(5), requiredCents: 5_000_000, dueDate: "2026-11-20" })).status).toBe(201);
    expect((await post(one, { action: "receipt", amountCents: 100, receivedOn: "2026-11-01", bankReference: "TFR" })).status).toBe(200);
    expect((await post(one, { action: "request", kind: "refund", amountCents: 100, reason: "Finance not approved, contract ended" })).status).toBe(200);
    expect((await post(lineRoute, { action: "receipt", holdingId: U(7) })).status).toBe(200);
    expect((await post(account, { csv: "Date,Amount\n2026-11-03,10.00\n", fileName: "nov.csv" })).status).toBe(201);
    state.staff = compliance;
    expect((await post(decide, { outcome: "approve", reason: "Checked with the solicitor" })).status).toBe(200);
    expect(state.calls.map(c => c[0])).toEqual(["create", "receipt", "request", "lineReceipt", "import", "decide"]);
    expect(state.calls[0]).toEqual(["create", { offerId: U(5), requiredCents: 5_000_000, dueDate: "2026-11-20" }]);
  });

  it("sale-fell-through steps: staff manage only, validated, pre-filled payouts take no amount from the request", async () => {
    const C = U(9);
    state.staff = support;
    expect((await post(one, { action: "case_payout", caseId: C })).status).toBe(403);
    state.staff = accountant;
    expect((await post(one, { action: "case_payout", caseId: "nope" })).status).toBe(400);
    expect((await post(one, { action: "case_resolve", caseId: C, source: "court_order", refundCents: 1, releaseCents: 0, reason: "Order made on 4 Nov" })).status).toBe(400); // no reference
    expect((await post(one, { action: "case_resolve", caseId: C, source: "whim", reason: "Order made on 4 Nov" })).status).toBe(400);
    expect(state.calls).toEqual([]);
    expect((await post(one, { action: "case_payout", caseId: C, amountCents: 99 })).status).toBe(200);
    expect((await post(one, { action: "case_resolve", caseId: C, source: "sale_continues", reason: "Parties confirmed the sale goes ahead" })).status).toBe(200);
    expect(state.calls.map(c => c[0])).toEqual(["casePayout", "caseResolve"]);
    expect(state.calls[0]).toEqual(["casePayout", C]);
  });

  it("returns the database refusal as is", async () => {
    state.staff = compliance;
    state.out = { ok: false, status: 403, error: "A second person must decide. You asked for this payment." };
    const r = await post(decide, { outcome: "approve", reason: "Checked with the solicitor" });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "A second person must decide. You asked for this payment." });
  });
});
