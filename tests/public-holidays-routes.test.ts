import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, calls: [] as unknown[][], audits: [] as string[], deleted: true }));

vi.mock("../src/server/context", () => ({ getActor: () => null, getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/public-holidays-db", () => ({
  listHolidaysPg: async (_db: unknown, year: number, s?: string) => { state.calls.push(["list", year, s]); return []; },
  upsertHolidayPg: async (_db: unknown, h: unknown) => { state.calls.push(["upsert", h]); return { id: "H1", created: true }; },
  generateHolidaysPg: async (_db: unknown, states: string[], year: number) => { state.calls.push(["generate", states, year]); return 9; },
  deleteHolidayPg: async () => (state.deleted ? { id: "H1", state: "NSW", date: "2026-04-03", name: "Good Friday" } : null)
}));

import * as list from "../app/api/staff/public-holidays/route";
import * as one from "../app/api/staff/public-holidays/[id]/route";
process.env["APP_URL"] = "http://test";

const comp: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "compliance" };
const support: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "support" };
const ID = "00000000-0000-4000-8000-000000000100";
const post = (body: unknown) => list.POST(new Request("http://test/api/staff/public-holidays", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) }));
const del = (id = ID) => one.DELETE(new Request("http://test/api/staff/public-holidays/x", { method: "DELETE", headers: { "content-type": "application/json", origin: "http://test" }, body: "{}" }), { params: Promise.resolve({ id }) });

beforeEach(() => { state.staff = null; state.calls = []; state.audits = []; state.deleted = true; });

describe("staff public holiday routes", () => {
  it("need a staff session with holiday.manage (compliance has it, support does not)", async () => {
    expect((await list.GET(new Request("http://test/api/staff/public-holidays"))).status).toBe(401);
    expect((await post({ state: "NSW", date: "2026-04-03", name: "Good Friday" })).status).toBe(401);
    state.staff = support;
    expect((await list.GET(new Request("http://test/api/staff/public-holidays"))).status).toBe(403);
    expect((await post({ state: "NSW", date: "2026-04-03", name: "Good Friday" })).status).toBe(403);
    expect((await del()).status).toBe(403);
    expect(state.calls).toEqual([]);
  });
  it("lists by year and state and rejects bad filters", async () => {
    state.staff = comp;
    expect((await list.GET(new Request("http://test/api/staff/public-holidays?year=2026&state=NSW"))).status).toBe(200);
    expect(state.calls[0]).toEqual(["list", 2026, "NSW"]);
    expect((await list.GET(new Request("http://test/api/staff/public-holidays?year=1800"))).status).toBe(400);
    expect((await list.GET(new Request("http://test/api/staff/public-holidays?state=ZZ"))).status).toBe(400);
  });
  it("adds a holiday and logs it; rejects bad input without saving", async () => {
    state.staff = comp;
    expect((await post({ state: "NSW", date: "2026-04-03", name: "Good Friday" })).status).toBe(201);
    expect(state.audits).toEqual(["staff.public_holiday_added"]);
    expect((await post({ state: "NSW", date: "2026-02-30", name: "Nope" })).status).toBe(400);
    expect(state.calls.filter(c => c[0] === "upsert")).toHaveLength(1);
  });
  it("fills in the usual holidays and logs how many were added", async () => {
    state.staff = comp;
    const r = await post({ action: "generate", state: "ALL", year: 2027 });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ added: 9 });
    expect(state.audits).toEqual(["staff.public_holidays_generated"]);
    expect((await post({ action: "generate", state: "ALL", year: 1 })).status).toBe(400);
  });
  it("removes a holiday, logs it, and 404s on an unknown or malformed id", async () => {
    state.staff = comp;
    expect((await del()).status).toBe(200);
    expect(state.audits).toEqual(["staff.public_holiday_removed"]);
    expect((await del("nope")).status).toBe(404);
    state.deleted = false;
    expect((await del()).status).toBe(404);
  });
});
