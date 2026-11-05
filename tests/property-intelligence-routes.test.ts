import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Comparable } from "../src/domain/price-guidance";

const state = vi.hoisted(() => ({ actor: null as unknown, comps: [] as unknown[], hits: 1 as number | undefined }));
vi.mock("../src/server/context", () => ({
  getActor: async () => state.actor, getDb: () => ({ query: async () => ({ rows: [] }) }), getDeps: () => ({ now: () => "2026-11-05T00:00:00.000Z" })
}));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/price-guidance", () => ({ getComparablesSource: () => ({ id: "t", find: async () => state.comps }) }));
vi.mock("../src/server/assistant-persona-db", () => ({ getLivePersona: async () => "elena" }));
import * as valuation from "../app/api/intelligence/valuation/route";
import * as market from "../app/api/intelligence/market/route";
import * as comparables from "../app/api/intelligence/comparables/route";
import * as trends from "../app/api/intelligence/trends/route";
import * as report from "../app/api/intelligence/report/route";
import * as ask from "../app/api/intelligence/ask/route";

const monthsAgo = (m: number) => new Date(Date.parse("2026-11-05T00:00:00.000Z") - m * 30.44 * 86_400_000).toISOString();
const comps = Array.from({ length: 36 }, (_, i): Comparable => ({
  id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: 120_000_000 + (i % 5) * 2_000_000, date: monthsAgo(i / 2), suburb: "Paddington", postcode: "4064", bedrooms: 3, bathrooms: 2, parking: 1, daysOnMarket: 35
}));
const url = (path: string, q = "suburb=Paddington&postcode=4064&bedrooms=3") => new Request(`http://test/api/intelligence/${path}?${q}`);
const post = (body: unknown) => new Request("http://test/api/intelligence/ask", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });

beforeEach(() => { process.env["APP_URL"] = "http://test"; state.actor = { userId: "u1", userType: "buyer" }; state.comps = comps; state.hits = 1; });

describe("intelligence routes", () => {
  it("need a signed-in user, a valid query, and stay within the hourly limit (fails closed)", async () => {
    state.actor = null;
    for (const r of [valuation, market, comparables, trends, report]) expect((await r.GET(url("x"))).status).toBe(401);
    state.actor = { userId: "u1", userType: "buyer" };
    expect((await valuation.GET(url("x", "bedrooms=3"))).status).toBe(400);
    expect((await valuation.GET(url("x", "suburb=X&condition=ruined"))).status).toBe(400);
    state.hits = 241;
    expect((await valuation.GET(url("x"))).status).toBe(429);
    state.hits = undefined;
    expect((await valuation.GET(url("x"))).status).toBe(429);
  });
  it("valuation returns the range, confidence and method, never the internal estimate", async () => {
    const res = await valuation.GET(url("valuation"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    const b = await res.json();
    expect(b.valuation).toMatchObject({ state: "ready", confidenceLabel: expect.any(String), intervalPercent: 60 });
    expect(b.valuation.lowCents).toBeLessThan(b.valuation.highCents);
    expect(b.valuation.methodology).toHaveLength(6);
    expect(b.valuation.estimate).toBeUndefined();
    expect(b.note).toMatch(/not a valuation/);
  });
  it("says unavailable instead of guessing when there is no data", async () => {
    state.comps = [];
    expect((await (await valuation.GET(url("v"))).json()).valuation).toMatchObject({ state: "unavailable" });
    expect((await (await market.GET(url("m"))).json()).market).toMatchObject({ state: "unavailable" });
    expect((await (await trends.GET(url("t"))).json()).trend).toMatchObject({ state: "unavailable" });
    expect((await (await comparables.GET(url("c"))).json()).comparables).toEqual([]);
  });
  it("market, comparables, trends and report answer from the same data", async () => {
    expect((await (await market.GET(url("m"))).json()).market).toMatchObject({ state: "ready", medianDaysOnMarket: 35 });
    expect((await (await comparables.GET(url("c"))).json()).comparables.length).toBeGreaterThan(3);
    expect((await (await trends.GET(url("t"))).json()).trend.state).toBe("ready");
    const r = (await (await report.GET(url("r"))).json()).report;
    expect(r.title).toBe("Market report: Paddington 4064");
    expect(r.sections.map((s: { heading: string }) => s.heading)).toContain("Value trend");
  });
});

describe("ask route", () => {
  it("answers from the figures as the live assistant", async () => {
    const b = await (await ask.POST(post({ suburb: "Paddington", postcode: "4064", question: "How confident is the estimate?" }))).json();
    expect(b).toMatchObject({ topic: "confidence", persona: { name: "Elena" } });
    expect(b.suggestions.length).toBeGreaterThan(0);
  });
  it("refuses a cross-site post, a missing or long question, bad JSON and signed-out users", async () => {
    const evil = new Request("http://test/api/intelligence/ask", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil" }, body: JSON.stringify({ suburb: "X", question: "hi" }) });
    expect((await ask.POST(evil)).status).toBeGreaterThanOrEqual(400);
    expect((await ask.POST(post({ suburb: "X" }))).status).toBe(400);
    expect((await ask.POST(post({ suburb: "X", question: "x".repeat(501) }))).status).toBe(400);
    expect((await ask.POST(new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: "nope" }))).status).toBe(400);
    state.actor = null;
    expect((await ask.POST(post({ suburb: "X", question: "hi" }))).status).toBe(401);
  });
});
