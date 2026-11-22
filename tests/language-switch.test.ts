import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, saved: [] as unknown[][], audits: [] as { eventType: string }[] }));
vi.mock("../src/server/context", () => ({ getActor: async () => null, getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }) }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_d: unknown, e: { eventType: string }) => { state.audits.push(e); } }));
vi.mock("../src/server/terms-db", () => ({ listLocaleStatusPg: async () => [], setLocaleEnabledPg: async (...a: unknown[]) => { state.saved.push(a); } }));
import * as route from "../app/api/staff/languages/route";
process.env["APP_URL"] = "http://test";

const admin: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
const compliance: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "compliance" };
const post = (body: unknown) => route.POST(new Request("http://test/api/staff/languages", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) }));

beforeEach(() => { Object.assign(state, { staff: null, saved: [], audits: [] }); });

describe("staff site languages", () => {
  it("needs staff with config.edit", async () => {
    expect((await route.GET(new Request("http://test/api/staff/languages"))).status).toBe(401);
    state.staff = compliance;
    expect((await post({ code: "fa", enabled: true })).status).toBe(403);
    expect(state.saved).toEqual([]);
  });
  it("lists Persian as approved and off", async () => {
    state.staff = admin;
    const d = await (await route.GET(new Request("http://test/api/staff/languages"))).json() as { languages: { code: string; approved: boolean; enabled: boolean }[] };
    expect(d.languages.find(l => l.code === "fa")).toMatchObject({ approved: true, enabled: false });
    expect(d.languages.find(l => l.code === "ar")).toMatchObject({ approved: false, enabled: false });
  });
  it("switches Persian on and logs it, but refuses an unapproved language", async () => {
    state.staff = admin;
    expect((await post({ code: "fa", enabled: true })).status).toBe(200);
    expect(state.saved).toHaveLength(1);
    expect(state.audits.map(a => a.eventType)).toContain("staff.language.enabled");
    expect((await post({ code: "ar", enabled: true })).status).toBe(409);
    expect((await post({ code: "en-AU", enabled: false })).status).toBe(400);
    expect(state.saved).toHaveLength(1);
  });
});
