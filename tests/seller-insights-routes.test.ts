import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Comparable } from "../src/domain/price-guidance";

const state = vi.hoisted(() => ({
  actor: null as unknown, comps: [] as unknown[], hits: 1 as number | undefined, listing: null as unknown, saved: [] as unknown[][]
}));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor,
  getDb: () => ({
    query: async (sql: string, p?: unknown[]) => {
      if (/INSERT INTO seller_pricing_preferences/.test(sql)) state.saved.push(p ?? []);
      return { rows: [] };
    }
  }),
  getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z", repo: { get: async () => state.listing } })
}));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/price-guidance", () => ({ getComparablesSource: () => ({ id: "t", find: async () => state.comps }) }));
import * as insights from "../app/api/owner/market-insights/route";
import * as advice from "../app/api/listings/[id]/pricing-advice/route";

const NOW = Date.parse("2026-11-05T00:00:00.000Z");
const comps = Array.from({ length: 12 }, (_, i): Comparable => ({
  id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: 100_000_000 + i * 2_000_000, date: new Date(NOW - (5 + i * 7) * 86_400_000).toISOString(),
  suburb: "Paddington", postcode: "4064", bedrooms: 3, daysOnMarket: 8 + i * 3
}));
const listing = (o: Record<string, unknown> = {}) => ({ listing: { id: "l1", ownerUserId: "u1", transactionType: "sale", propertyType: "house", suburb: "Paddington", postcode: "4064", bedrooms: 3, priceCents: 115_000_000, ...o } });
const get = (q = "suburb=Paddington&postcode=4064") => new Request(`http://test/api/owner/market-insights?${q}`);
const ctx = { params: Promise.resolve({ id: "l1" }) };
const post = (body: unknown) => new Request("http://test/api/listings/l1/pricing-advice", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });

beforeEach(() => {
  process.env["APP_URL"] = "http://test";
  Object.assign(state, { actor: { userId: "u1", userType: "owner" }, comps, hits: 1, listing: listing(), saved: [] });
});

describe("GET /api/owner/market-insights", () => {
  it("needs sign-in, a valid query and stays within the hourly limit (fails closed)", async () => {
    state.actor = null;
    expect((await insights.GET(get())).status).toBe(401);
    state.actor = { userId: "u1", userType: "owner" };
    expect((await insights.GET(get("bedrooms=3"))).status).toBe(400);
    state.hits = 241;
    expect((await insights.GET(get())).status).toBe(429);
    state.hits = undefined;
    expect((await insights.GET(get())).status).toBe(429);
  });
  it("returns comparable sales, trend, days on market and the guide, never cached by browsers", async () => {
    const res = await insights.GET(get());
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = await res.json();
    expect(b.comparables.state).toBe("ready");
    expect(b.daysOnMarket.state).toBe("ready");
    expect(b.pricingGuide.curve.length).toBeGreaterThan(2);
    expect(b.note).toMatch(/not a valuation/);
  });
  it("ignores a rent request: sales only", async () => {
    const b = await (await insights.GET(get("suburb=Paddington&transactionType=rent"))).json();
    expect(b.query.transactionType).toBe("sale");
  });
  it("says unavailable with no data", async () => {
    state.comps = [];
    const b = await (await insights.GET(get())).json();
    expect(b.comparables.state).toBe("unavailable");
    expect(b.pricingGuide.state).toBe("unavailable");
  });
});

describe("/api/listings/[id]/pricing-advice", () => {
  it("is for the listing owner only (404 for anyone else, 401 signed out)", async () => {
    state.actor = null;
    expect((await advice.GET(get(), ctx)).status).toBe(401);
    state.actor = { userId: "u2", userType: "owner" };
    expect((await advice.GET(get(), ctx)).status).toBe(404);
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await advice.GET(get(), ctx)).status).toBe(404);
  });
  it("GET shows balanced advice and saves nothing", async () => {
    const b = await (await advice.GET(get(), ctx)).json();
    expect(b.goal).toBe("balanced");
    expect(b.advice.state).toBe("ready");
    expect(b.askingCents).toBe(115_000_000);
    expect(state.saved).toHaveLength(0);
  });
  it("POST saves the goal and the advice shown; rejects an unknown goal", async () => {
    const b = await (await advice.POST(post({ goal: "fast_sale" }), ctx)).json();
    expect(b.goal).toBe("fast_sale");
    expect(b.advice.recommendedCents).toBeLessThan(b.scenarios?.[1]?.priceCents ?? Infinity);
    expect(state.saved).toHaveLength(1);
    expect(state.saved[0]![1]).toBe("fast_sale");
    expect((await advice.POST(post({ goal: "whatever" }), ctx)).status).toBe(400);
  });
  it("refuses rentals and listings with no area", async () => {
    state.listing = listing({ transactionType: "rent" });
    expect((await advice.GET(get(), ctx)).status).toBe(400);
    state.listing = listing({ suburb: undefined, postcode: undefined });
    expect((await advice.GET(get(), ctx)).status).toBe(400);
  });
});
