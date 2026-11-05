import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, calls: [] as unknown[][], audits: [] as string[], voidOutcome: "voided" as string }));

vi.mock("../src/server/context", () => ({
  getActor: () => null, getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff, getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z" })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/sale-events-db", () => ({
  listSaleEventsPg: async (_db: unknown, f: unknown, full: boolean) => { state.calls.push(["list", f, full]); return { rows: [], nextCursor: null }; },
  recordManualEventPg: async (_db: unknown, e: { suburb: string }, staffId: string) => { state.calls.push(["record", e.suburb, staffId]); return "E1"; },
  backfillAcceptedOfferEventsPg: async () => ({ checked: 3, written: 2 }),
  voidSaleEventPg: async (_db: unknown, id: string, staffId: string, reason: string) => {
    state.calls.push(["void", id, staffId, reason]);
    return state.voidOutcome === "voided" ? { outcome: "voided", propertyId: "P1" } : { outcome: state.voidOutcome };
  }
}));

import * as list from "../app/api/staff/sale-events/route";
import * as one from "../app/api/staff/sale-events/[id]/route";
process.env["APP_URL"] = "http://test";

const comp: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "compliance" };
const reporting: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "reporting" };
const designer: StaffActor = { id: "00000000-0000-4000-8000-000000000003", role: "designer" };
const ID = "00000000-0000-4000-8000-000000000100";
const REASON = "Entered from the title search for the address.";
const req = (url: string, body?: unknown) => new Request(url, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: "http://test" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const entry = { eventType: "sold", amountCents: 85_000_000, occurredAt: "2025-03-14T00:00:00.000Z", source: "public_record", address: "12 Burke St", state: "QLD", suburb: "Paddington", postcode: "4064", propertyType: "house", reason: REASON };

beforeEach(() => { state.staff = null; state.calls = []; state.audits = []; state.voidOutcome = "voided"; });

describe("staff sale-event routes", () => {
  it("need staff; reading needs sale_event.manage or report.sales; writing needs sale_event.manage", async () => {
    expect((await list.GET(req("http://test/api/staff/sale-events"))).status).toBe(401);
    state.staff = designer;
    expect((await list.GET(req("http://test/api/staff/sale-events"))).status).toBe(403);
    state.staff = reporting;
    const r = await list.GET(req("http://test/api/staff/sale-events"));
    expect(r.status).toBe(200);
    expect((await r.json()).canManage).toBe(false);
    expect((await list.POST(req("http://test/api/staff/sale-events", entry))).status).toBe(403);
    expect((await one.POST(req("http://test/x", { reason: REASON }), { params: Promise.resolve({ id: ID }) })).status).toBe(403);
    expect(state.calls.filter(c => c[0] !== "list")).toEqual([]);
  });

  it("shows names in full only to staff with full personal details, and logs the view", async () => {
    state.staff = comp;
    expect((await (await list.GET(req("http://test/api/staff/sale-events?type=sold&status=voided"))).json()).canManage).toBe(true);
    state.staff = reporting;
    await list.GET(req("http://test/api/staff/sale-events?type=bogus"));
    expect(state.calls).toEqual([["list", { status: "voided", type: "sold" }, true], ["list", { status: "active" }, false]]);
    expect(state.audits).toEqual(["staff.sale_events_viewed", "staff.sale_events_viewed"]);
  });

  it("records a historical event with a reason and audits it; refuses a bad entry or a missing reason", async () => {
    state.staff = comp;
    const ok = await list.POST(req("http://test/api/staff/sale-events", entry));
    expect(ok.status).toBe(201);
    expect(state.calls).toEqual([["record", "Paddington", comp.id]]);
    expect(state.audits).toEqual(["staff.sale_event_recorded"]);
    expect((await list.POST(req("http://test/api/staff/sale-events", { ...entry, reason: "short" }))).status).toBe(400);
    const future = await list.POST(req("http://test/api/staff/sale-events", { ...entry, occurredAt: "2027-01-01T00:00:00Z" }));
    expect(future.status).toBe(400);
    expect((await future.json()).error).toMatch(/future/);
    expect(state.calls).toHaveLength(1);
  });

  it("sweeps accepted offers that have no event", async () => {
    state.staff = comp;
    const r = await list.POST(req("http://test/api/staff/sale-events", { action: "sweep", reason: "Sweep after the release." }));
    expect(await r.json()).toEqual({ ok: true, checked: 3, written: 2 });
    expect(state.audits).toEqual(["staff.sale_events_swept"]);
  });

  it("voids with a reason: 200, 404, 409, and a bad id or reason is refused", async () => {
    state.staff = comp;
    const go = (id: string, body: unknown) => one.POST(req("http://test/x", body), { params: Promise.resolve({ id }) });
    expect((await go(ID, { reason: REASON })).status).toBe(200);
    expect(state.calls).toEqual([["void", ID, comp.id, REASON]]);
    expect(state.audits).toEqual(["staff.sale_event_voided"]);
    expect((await go(ID, { reason: "no" })).status).toBe(400);
    expect((await go("nope", { reason: REASON })).status).toBe(404);
    state.voidOutcome = "already_voided";
    expect((await go(ID, { reason: REASON })).status).toBe(409);
    state.voidOutcome = "not_found";
    expect((await go(ID, { reason: REASON })).status).toBe(404);
  });
});
