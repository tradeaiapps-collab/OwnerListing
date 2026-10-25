import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptanceRate, buildOverview, changePercent, formatKpi, labelFor, type RawOverview } from "../src/domain/admin-dashboard";
import type { StaffActor } from "../src/domain/staff-access";
import { niceMax } from "../app/staff/charts";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, loads: 0 }));
vi.mock("../src/server/context", () => ({ getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff }));
vi.mock("../src/server/admin-dashboard-db", () => ({ loadOverview: async () => { state.loads++; return raw(); } }));

import * as route from "../app/api/staff/dashboard/route";

const raw = (o: Partial<RawOverview> = {}): RawOverview => ({
  listingsByStatus: [{ key: "published", count: 12 }, { key: "pending_review", count: 2 }, { key: "suspended", count: 1 }],
  newListings: { current: 6, previous: 4 }, offersSubmitted: { current: 10, previous: 0 }, offersAccepted: { current: 3, previous: 0 },
  revenueCents: { current: 59_700, previous: 39_800 },
  usersByType: [{ key: "owner", count: 9 }, { key: "buyer", count: 30 }, { key: "admin", count: 2 }],
  newUsers: { current: 8, previous: 8 }, suspendedUsers: 1, openCases: 4, idPending: 2, ...o
});
const keys = (a: StaffActor) => buildOverview(a, raw()).kpis.map(k => k.key);

describe("admin dashboard figures", () => {
  it("acceptance rate is a whole percent, capped at 100 and 0 with no offers", () => {
    expect(acceptanceRate(3, 10)).toBe(30);
    expect(acceptanceRate(0, 0)).toBe(0);
    expect(acceptanceRate(5, 4)).toBe(100);
  });
  it("change is null without an earlier figure", () => {
    expect(changePercent(6, 4)).toBe(50);
    expect(changePercent(2, 4)).toBe(-50);
    expect(changePercent(5, 0)).toBeNull();
  });
  it("each role sees only its own blocks", () => {
    expect(keys({ id: "a", role: "accountant" })).toEqual(["published", "new_listings", "offers", "acceptance", "revenue", "new_users"]);
    expect(keys({ id: "t", role: "technical" })).toEqual(["open_cases", "id_pending"]);
    expect(keys({ id: "c", role: "compliance" })).toEqual(["published", "pending_review", "suspended", "new_users", "suspended_users"]);
    expect(keys({ id: "d", role: "designer" })).toEqual([]);
    expect(buildOverview({ id: "t", role: "technical" }, raw()).listingsByStatus).toBeUndefined();
  });
  it("revenue only with the financial report permission", () => {
    expect(keys({ id: "r", role: "reporting" })).not.toContain("revenue");
    const rev = buildOverview({ id: "s", role: "super_admin" }, raw()).kpis.find(k => k.key === "revenue")!;
    expect(rev).toMatchObject({ value: 59_700, previous: 39_800, unit: "cents" });
  });
  it("staff accounts are not counted as users and bad numbers become zero", () => {
    const o = buildOverview({ id: "s", role: "super_admin" }, raw({ openCases: Number.NaN, newUsers: { current: -3, previous: 2 } }));
    expect(o.usersByType?.map(u => u.key)).toEqual(["owner", "buyer"]);
    expect(o.kpis.find(k => k.key === "open_cases")?.value).toBe(0);
    expect(o.kpis.find(k => k.key === "new_users")?.value).toBe(0);
  });
  it("formats money, percent and labels", () => {
    expect(formatKpi(59_700, "cents")).toBe("$597");
    expect(formatKpi(30, "percent")).toBe("30%");
    expect(labelFor("pending_review")).toBe("Under review");
    expect(labelFor("new_kind")).toBe("new kind");
  });
  it("chart axis tops land on 1/2/5 steps", () => {
    expect([0, 3, 7, 12, 180, 999].map(niceMax)).toEqual([1, 5, 10, 20, 200, 1000]);
  });
});

describe("GET /api/staff/dashboard", () => {
  beforeEach(() => { state.staff = null; state.loads = 0; });
  const get = () => route.GET(new Request("http://test/api/staff/dashboard"));
  it("needs a staff session", async () => {
    expect((await get()).status).toBe(401);
    expect(state.loads).toBe(0);
  });
  it("refuses a role with no dashboard permission", async () => {
    state.staff = { id: "d", role: "designer" };
    expect((await get()).status).toBe(403);
    expect(state.loads).toBe(0);
  });
  it("returns the role's figures", async () => {
    state.staff = { id: "t", role: "technical" };
    const r = await get();
    expect(r.status).toBe(200);
    expect((await r.json()).overview.kpis.map((k: { key: string }) => k.key)).toEqual(["open_cases", "id_pending"]);
  });
});
