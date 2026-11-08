import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Comparable } from "../src/domain/price-guidance";

const state = vi.hoisted(() => ({ actor: null as unknown, comps: [] as unknown[], hits: 1 as number | undefined, demand: undefined as unknown, ran: 0 }));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor, getDb: () => ({ query: async () => ({ rows: [] }) }), getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z" })
}));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/price-guidance", () => ({ getComparablesSource: () => ({ id: "t", find: async () => state.comps }) }));
vi.mock("../src/server/assistant-persona-db", () => ({ getLivePersona: async () => "elena" }));
vi.mock("../src/server/market-intel-db", () => ({
  loadDemandFacts: async () => state.demand,
  runMarketShiftAlerts: async () => { state.ran++; return { areas: 1, shifts: 2, notified: 2 }; }
}));
import * as forecast from "../app/api/intelligence/forecast/route";
import * as investment from "../app/api/intelligence/investment/route";
import * as demand from "../app/api/intelligence/demand/route";
import * as valuation from "../app/api/intelligence/valuation/route";
import * as ask from "../app/api/intelligence/ask/route";
import * as cron from "../app/api/internal/market-shifts/run/route";

const monthsAgo = (m: number) => new Date(Date.parse("2026-11-05T00:00:00.000Z") - m * 30.44 * 86_400_000).toISOString();
const sale = (i: number): Comparable => ({
  id: `s${i}`, transactionType: "sale", propertyType: "house", priceCents: Math.round(130_000_000 * (1 - 0.01 * Math.floor(i / 3))), date: monthsAgo(Math.floor(i / 3) + (i % 3) * 0.2),
  suburb: "Paddington", postcode: "4064", bedrooms: 3, bathrooms: 2, parking: 1, daysOnMarket: 35
});
const rent = (i: number): Comparable => ({ ...sale(i), id: `r${i}`, transactionType: "rent", priceCents: 70_000 });
const url = (path: string, q = "suburb=Paddington&postcode=4064&bedrooms=3") => new Request(`http://test/api/intelligence/${path}?${q}`);
const post = (body: unknown) => new Request("http://test/api/intelligence/ask", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
const FACTS = { weeks: [2, 3, 3, 5, 6, 8, 9, 12].map(e => ({ saves: e, enquiries: e, offers: 0 })), activeListings: 3 };

beforeEach(() => {
  process.env["APP_URL"] = "http://test"; state.actor = { userId: "u1", userType: "buyer" };
  state.comps = [...Array.from({ length: 72 }, (_, i) => sale(i)), ...Array.from({ length: 36 }, (_, i) => rent(i))]; state.hits = 1; state.demand = FACTS; state.ran = 0;
});

describe("forecast, investment and demand routes", () => {
  it("need a signed-in user and a valid query, and fail closed past the hourly limit", async () => {
    state.actor = null;
    for (const r of [forecast, investment, demand]) expect((await r.GET(url("x"))).status).toBe(401);
    state.actor = { userId: "u1", userType: "buyer" };
    for (const r of [forecast, investment, demand]) expect((await r.GET(url("x", "bedrooms=3"))).status).toBe(400);
    state.hits = undefined;
    for (const r of [forecast, investment, demand]) expect((await r.GET(url("x"))).status).toBe(429);
  });
  it("forecast gives 3, 6 and 12 month ranges with the not-a-prediction note", async () => {
    const res = await forecast.GET(url("forecast"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = await res.json();
    expect(b.forecast).toMatchObject({ state: "ready", direction: "rising" });
    expect(b.forecast.horizons).toHaveLength(3);
    expect(b.note).toMatch(/not a prediction/i);
  });
  it("investment scores the area and includes the yield when rents exist", async () => {
    const b = await (await investment.GET(url("investment"))).json();
    expect(b.score).toMatchObject({ state: "ready" });
    expect(b.score.components.map((c: { key: string }) => c.key)).toContain("yield");
    expect(b.note).toMatch(/not .*advice/i);
  });
  it("demand returns counts-based outlook, or unavailable when thin or when the lookup fails", async () => {
    expect((await (await demand.GET(url("demand"))).json()).demand).toMatchObject({ state: "ready", outlook: "rising" });
    state.demand = { weeks: FACTS.weeks.map(() => ({ saves: 0, enquiries: 0, offers: 0 })), activeListings: 1 };
    expect((await (await demand.GET(url("demand"))).json()).demand.state).toBe("unavailable");
    state.demand = undefined;
    expect((await (await demand.GET(url("demand"))).json()).demand.state).toBe("unavailable");
  });
  it("no data means unavailable, not a guess", async () => {
    state.comps = [];
    expect((await (await forecast.GET(url("f"))).json()).forecast.state).toBe("unavailable");
    expect((await (await investment.GET(url("i"))).json()).score.state).toBe("unavailable");
  });
  it("valuation now carries the breakdown", async () => {
    const b = (await (await valuation.GET(url("valuation"))).json()).valuation;
    expect(b.breakdown.steps).toHaveLength(4);
    expect(b.estimate).toBeUndefined();
  });
});

describe("Elena asks", () => {
  it("answers the new topics through the ask route", async () => {
    const f = await (await ask.POST(post({ suburb: "Paddington", postcode: "4064", question: "Where are prices heading?" }))).json();
    expect(f.text).toMatch(/12 months/);
    const d = await (await ask.POST(post({ suburb: "Paddington", postcode: "4064", question: "How is buyer demand?" }))).json();
    expect(d.text).toMatch(/rising/);
    expect(d.persona.name).toBeTruthy();
  });
  it("still works when buyer activity cannot be loaded", async () => {
    state.demand = undefined;
    const d = await (await ask.POST(post({ suburb: "Paddington", question: "How is buyer demand?" }))).json();
    expect(d.text).toMatch(/don't have buyer activity/);
  });
});

describe("market-shift job route", () => {
  const call = (secret?: string) => cron.POST(new Request("http://test/api/internal/market-shifts/run", { method: "POST", headers: secret ? { "x-cron-secret": secret } : {} }));
  it("fails closed without a long secret and rejects a wrong one", async () => {
    delete process.env["MARKET_SHIFT_CRON_SECRET"];
    expect((await call("x")).status).toBe(503);
    process.env["MARKET_SHIFT_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    process.env["MARKET_SHIFT_CRON_SECRET"] = "s".repeat(40);
    expect((await call()).status).toBe(401);
    expect((await call("wrong")).status).toBe(401);
    expect(state.ran).toBe(0);
  });
  it("runs with the right secret", async () => {
    process.env["MARKET_SHIFT_CRON_SECRET"] = "s".repeat(40);
    const res = await call("s".repeat(40));
    expect(res.status).toBe(200);
    expect((await res.json()).counts).toEqual({ areas: 1, shifts: 2, notified: 2 });
    expect(state.ran).toBe(1);
  });
});
