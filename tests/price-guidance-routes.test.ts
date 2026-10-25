import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rulesOnlyEngine } from "../src/domain/ai-engine";
import type { Comparable } from "../src/domain/price-guidance";

const state = vi.hoisted(() => ({
  handler: null as unknown, comps: [] as Comparable[], stored: [] as { lowCents: number; midCents: number; highCents: number }[], latest: undefined as unknown,
  hits: 1 as number, engine: null as unknown, audits: [] as string[]
}));
vi.mock("../src/server/context", () => ({
  getDb: () => ({}),
  getDeps: () => ({ now: () => "2026-10-25T00:00:00.000Z", newId: () => crypto.randomUUID(), appendAudit: async (e: { eventType: string }) => { state.audits.push(e.eventType); } })
}));
vi.mock("../src/server/owner-listing", () => ({ requireListingHandler: async () => state.handler }));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/ai", () => ({ getAiEngine: async () => state.engine }));
vi.mock("../src/server/price-guidance", () => ({
  getComparablesSource: () => ({ id: "file", find: async () => state.comps }),
  insertPriceEstimatePg: async (_db: unknown, _id: string, _l: string, e: { lowCents: number; midCents: number; highCents: number }) => { state.stored.push(e); },
  latestPriceEstimatePg: async () => state.latest
}));
import * as route from "../app/api/listings/[id]/price-guidance/route";

const ctx = { params: Promise.resolve({ id: "L1" }) };
const get = () => new Request("http://test/x");
const post = () => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: "{}" });
const handler = { actor: { userId: "u1", userType: "owner" }, rec: { listing: { id: "L1", transactionType: "sale", propertyType: "house", suburb: "Paddington", bedrooms: 3 } }, asAgent: false };
const comps = [118, 120, 122].map((p, i): Comparable => ({ id: `c${i}`, transactionType: "sale", propertyType: "house", priceCents: p * 1_000_000, date: "2026-09-01T00:00:00.000Z", suburb: "Paddington", bedrooms: 3, label: "12 Example St" }));

beforeEach(() => { process.env["APP_URL"] = "http://test"; state.handler = handler; state.comps = comps; state.stored = []; state.latest = undefined; state.hits = 1; state.engine = rulesOnlyEngine; state.audits = []; });

describe("price guidance route", () => {
  it("passes through the listing check (401/404 for anyone but the owner or agent)", async () => {
    state.handler = NextResponse.json({ error: "Listing not found." }, { status: 404 });
    expect((await route.GET(get(), ctx)).status).toBe(404);
  });
  it("no data: 200 with Estimate unavailable, nothing stored", async () => {
    state.comps = [];
    expect(await (await route.GET(get(), ctx)).json()).toMatchObject({ state: "unavailable" });
    expect(state.stored).toEqual([]);
  });
  it("returns the range, stores it once while unchanged, and never calls AI on GET", async () => {
    const b = await (await route.GET(get(), ctx)).json();
    expect(b).toMatchObject({ state: "ready", midCents: 120_000_000, explanation: { state: "not_requested" } });
    expect(b.comparables).toHaveLength(3);
    expect(state.stored).toHaveLength(1);
    expect(state.audits).toEqual(["listing.price_guidance_estimated"]);
    state.latest = { ...state.stored[0], createdAt: "2026-10-24T12:00:00.000Z" };
    await route.GET(get(), ctx);
    expect(state.stored).toHaveLength(1);
  });
  it("POST adds the AI explanation state, rate limited, CSRF checked", async () => {
    expect((await route.POST(new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil" }, body: "{}" }), ctx)).status).toBe(403);
    expect((await (await route.POST(post(), ctx)).json()).explanation).toEqual({ state: "unavailable" });
    state.hits = 21;
    expect((await route.POST(post(), ctx)).status).toBe(429);
  });
});
