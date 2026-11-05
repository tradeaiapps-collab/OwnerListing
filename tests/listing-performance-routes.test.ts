import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";

const OWN = "00000000-0000-4000-8000-0000000000a1";
const state = vi.hoisted(() => ({ actor: null as unknown, staff: null as StaffActor | null, rec: null as unknown, built: [] as string[] }));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor, getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }),
  getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z", repo: { get: async () => state.rec } })
}));
vi.mock("../src/server/listing-performance-db", () => ({
  loadListingFacts: async (_db: unknown, id: string) => ({ id, title: "Home", status: "published", propertyType: "house", createdAt: "2026-10-01T00:00:00.000Z", jurisdiction: "QLD" }),
  buildReport: async (_db: unknown, f: { id: string }) => { state.built.push(f.id); return { listing: { id: f.id }, windows: [], daily: [] }; },
  buildStaffReport: async () => ({ listings: 2, daily: [], needsAttention: [] })
}));
import * as owner from "../app/api/owner/listing-performance/route";
import * as staff from "../app/api/staff/listing-performance-analytics/route";

const rec = (o: Record<string, unknown> = {}) => ({ listing: { id: OWN, ownerUserId: "u1", transactionType: "sale", ...o } });
const get = (q = `listing=${OWN}`) => owner.GET(new Request(`http://test/api/owner/listing-performance?${q}`));
beforeEach(() => { process.env["APP_URL"] = "http://test"; Object.assign(state, { actor: { userId: "u1", userType: "owner" }, staff: null, rec: rec(), built: [] }); });

describe("GET /api/owner/listing-performance", () => {
  it("returns the report to the listing's owner, never cached by browsers", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(state.built).toEqual([OWN]);
  });
  it("needs sign-in and a listing id", async () => {
    state.actor = null;
    expect((await get()).status).toBe(401);
    state.actor = { userId: "u1", userType: "owner" };
    expect((await get("listing=nope")).status).toBe(400);
    expect((await get("")).status).toBe(400);
  });
  it("is owner only: other owners, agents and buyers get 404 and nothing is built", async () => {
    for (const a of [{ userId: "u2", userType: "owner" }, { userId: "u1", userType: "agent" }, { userId: "u3", userType: "buyer" }]) {
      state.actor = a;
      expect((await get()).status).toBe(404);
    }
    state.actor = { userId: "u1", userType: "owner" }; state.rec = null;
    expect((await get()).status).toBe(404);
    expect(state.built).toEqual([]);
  });
  it("is for sale listings only", async () => {
    state.rec = rec({ transactionType: "rent" });
    expect((await get()).status).toBe(400);
  });
});

describe("GET /api/staff/listing-performance-analytics", () => {
  const call = () => staff.GET(new Request("http://test/api/staff/listing-performance-analytics"));
  it("needs staff with report.sales", async () => {
    expect((await call()).status).toBe(401);
    state.staff = { id: "s1", role: "designer" };
    expect((await call()).status).toBe(403);
    state.staff = { id: "s2", role: "reporting" };
    const r = await call();
    expect(r.status).toBe(200);
    expect((await r.json()).listings).toBe(2);
  });
  it("is not open to owners", async () => {
    state.actor = { userId: "u1", userType: "owner" };
    expect((await call()).status).toBe(401);
  });
});
