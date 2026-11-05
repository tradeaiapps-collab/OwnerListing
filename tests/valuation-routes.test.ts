import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import type { Comparable } from "../src/domain/price-guidance";

const state = vi.hoisted(() => ({
  staff: null as StaffActor | null, actor: null as unknown, settings: { enabled: false, minComps: 8, highConfidenceComps: 12, showRange: true, updatedAt: null, updatedBy: null, updatedByName: null } as Record<string, unknown>,
  override: undefined as unknown, saved: [] as unknown[], audits: [] as { eventType: string; payload: Record<string, unknown> }[], comps: [] as unknown[], hits: 1 as number | undefined, listing: null as unknown
}));
const LID = "00000000-0000-4000-8000-000000000100";
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor, getStaff: async () => state.staff, getDb: () => ({ query: async () => ({ rows: [] }) }),
  getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z", repo: { get: async () => state.listing } })
}));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_d: unknown, e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); } }));
vi.mock("../src/server/valuation-db", () => ({
  getValuationSettings: async () => state.settings, saveValuationSettings: async (_d: unknown, s: unknown) => { state.saved.push(s); Object.assign(state.settings, s); },
  getOverride: async () => state.override, setOverride: async (_d: unknown, _id: string, enabled: boolean, reason: string) => { state.override = { enabled, reason, setAt: "2026-11-05T00:00:00.000Z" }; },
  clearOverride: async () => { state.override = undefined; return true; }, listOverrides: async () => [], recentValuationChanges: async () => []
}));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/property-intelligence", async orig => ({ ...(await orig<object>()), getIntelligenceSource: () => ({ id: "t", find: async () => state.comps }) }));
vi.mock("../src/server/seller-insights-db", async orig => {
  const real = await orig<typeof import("../src/server/seller-insights-db")>();
  return { ...real, getSellerInsights: async (_d: unknown, s: never, now: string, load: () => Promise<Comparable[]>) => (await import("../src/domain/seller-insights")).sellerBundle(s, await load(), now) };
});
import * as settingsRoute from "../app/api/staff/valuation-settings/route";
import * as staffListing from "../app/api/staff/listings/[id]/valuation/route";
import * as buyer from "../app/api/listings/[id]/valuation/route";
process.env["APP_URL"] = "http://test";

const NOW = Date.parse("2026-11-05T00:00:00.000Z");
const sales = Array.from({ length: 12 }, (_, i): Comparable => ({
  id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: 100_000_000 + i * 2_000_000, date: new Date(NOW - (5 + i * 7) * 86_400_000).toISOString(),
  suburb: "Paddington", postcode: "4064", bedrooms: 3, daysOnMarket: 8 + i * 3
}));
const admin: StaffActor = { id: "00000000-0000-4000-8000-000000000001", role: "super_admin" };
const compliance: StaffActor = { id: "00000000-0000-4000-8000-000000000002", role: "compliance" };
const listing = (o: Record<string, unknown> = {}) => ({ listing: { id: LID, ownerUserId: "u9", status: "published", transactionType: "sale", propertyType: "house", title: "House", suburb: "Paddington", postcode: "4064", bedrooms: 3, priceCents: 114_000_000, ...o } });
const ctx = { params: Promise.resolve({ id: LID }) };
const json = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
const getBuyer = () => buyer.GET(new Request(`http://test/api/listings/${LID}/valuation`), ctx);

beforeEach(() => {
  Object.assign(state, { staff: null, actor: { userId: "u1", userType: "buyer" }, override: undefined, saved: [], audits: [], comps: sales, hits: 1, listing: listing() });
  Object.assign(state.settings, { enabled: false, minComps: 8, highConfidenceComps: 12, showRange: true });
});

describe("staff valuation settings", () => {
  it("need the valuation.manage permission, which only a super admin holds", async () => {
    expect((await settingsRoute.GET(new Request("http://test/api/staff/valuation-settings"))).status).toBe(401);
    state.staff = compliance;
    expect((await settingsRoute.GET(new Request("http://test/api/staff/valuation-settings"))).status).toBe(403);
    expect((await settingsRoute.POST(json("http://test/x", { enabled: true }))).status).toBe(403);
    expect((await staffListing.POST(json("http://test/x", { enabled: false, reason: "no" }), ctx)).status).toBe(403);
    expect(state.saved).toEqual([]);
  });
  it("turns the site switch on and logs who and the before and after", async () => {
    state.staff = admin;
    const res = await settingsRoute.POST(json("http://test/x", { enabled: true }));
    expect(res.status).toBe(200);
    expect(state.audits[0]).toMatchObject({ eventType: "staff.valuation.enabled", payload: { before: { enabled: false }, after: { enabled: true } } });
    await settingsRoute.POST(json("http://test/x", { minComps: 10 }));
    expect(state.audits[1]!.eventType).toBe("staff.valuation.updated");
  });
  it("rejects bad numbers without saving", async () => {
    state.staff = admin;
    expect((await settingsRoute.POST(json("http://test/x", { minComps: 1 }))).status).toBe(400);
    expect((await settingsRoute.POST(json("http://test/x", { minComps: 30 }))).status).toBe(400);
    expect(state.saved).toEqual([]);
  });
  it("sets a per-listing override only with a reason, and clears it", async () => {
    state.staff = admin;
    expect((await staffListing.POST(json("http://test/x", { enabled: false }), ctx)).status).toBe(400);
    const res = await staffListing.POST(json("http://test/x", { enabled: false, reason: "Seller disputes the sales" }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).visibleToBuyers).toBe(false);
    expect(state.audits[0]!.eventType).toBe("staff.valuation.listing_disabled");
    await staffListing.POST(json("http://test/x", { enabled: null }), ctx);
    expect(state.audits[1]!.eventType).toBe("staff.valuation.override_cleared");
  });
  it("shows staff the calculated assessment even while the site switch is off", async () => {
    state.staff = admin;
    const b = await (await staffListing.GET(new Request("http://test/x"), ctx)).json();
    expect(b.settingsEnabled).toBe(false);
    expect(b.visibleToBuyers).toBe(false);
    expect(b.valuation.state).toBe("ready");
  });
});

describe("GET /api/listings/[id]/valuation", () => {
  it("answers 404 while the site switch is off, whatever the listing override says", async () => {
    state.override = { enabled: true };
    expect((await getBuyer()).status).toBe(404);
  });
  it("needs sign-in and stays within the hourly limit (fails closed)", async () => {
    state.settings["enabled"] = true;
    state.actor = null;
    expect((await getBuyer()).status).toBe(401);
    state.actor = { userId: "u1", userType: "buyer" };
    state.hits = 241;
    expect((await getBuyer()).status).toBe(429);
    state.hits = undefined;
    expect((await getBuyer()).status).toBe(429);
  });
  it("returns the valuation when on, and 404 when this listing is turned off or is not published", async () => {
    state.settings["enabled"] = true;
    const ok = await getBuyer();
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const v = (await ok.json()).valuation;
    expect(v).toMatchObject({ state: "ready", band: "fair", medianCents: 111_000_000 });
    state.override = { enabled: false };
    expect((await getBuyer()).status).toBe(404);
    state.override = undefined;
    state.listing = listing({ status: "draft" });
    expect((await getBuyer()).status).toBe(404);
  });
  it("says unavailable under the minimum number of sales and for rentals", async () => {
    state.settings["enabled"] = true;
    state.comps = sales.slice(0, 5);
    expect((await (await getBuyer()).json()).valuation.state).toBe("unavailable");
    state.listing = listing({ transactionType: "rent" });
    expect((await (await getBuyer()).json()).valuation.state).toBe("unavailable");
  });
});
