import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceSuggestion } from "../src/domain/price-suggestion";

const state = vi.hoisted(() => ({ handler: null as unknown, result: null as unknown, audits: [] as { eventType: string; payload: Record<string, unknown> }[], args: null as unknown }));
vi.mock("../src/server/context", () => ({
  getDb: () => ({}),
  getDeps: () => ({ now: () => "2026-11-20T00:00:00.000Z", newId: () => crypto.randomUUID(), appendAudit: async (e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); } })
}));
vi.mock("../src/server/owner-listing", () => ({ requireListingHandler: async () => state.handler }));
vi.mock("../src/server/price-suggestion", () => ({ suggestPrice: async (...a: unknown[]) => { state.args = a; return state.result; } }));
import * as route from "../app/api/listings/[id]/price-suggestion/route";

const ctx = { params: Promise.resolve({ id: "L1" }) };
const handler = { actor: { userId: "u1" }, rec: { listing: { id: "L1", jurisdiction: "QLD", transactionType: "sale", propertyType: "house", suburb: "Paddington", bedrooms: 3, priceCents: 150_000_000 } } };

beforeEach(() => { state.handler = handler; state.audits = []; state.args = null; });

describe("price suggestion route", () => {
  it("passes through the listing check (404 for anyone but the owner or agent)", async () => {
    state.handler = NextResponse.json({ error: "Listing not found." }, { status: 404 });
    expect((await route.GET(new Request("http://test/x"), ctx)).status).toBe(404);
    expect(state.audits).toEqual([]);
  });
  it("returns the suggestion uncached, passes the current price, and logs the view", async () => {
    state.result = { state: "ready", basis: "sold_comparables", confidence: "medium", lowCents: 1, midCents: 2, highCents: 3, evidence: [{}, {}, {}], modelVersion: "v" } as unknown as PriceSuggestion;
    const res = await route.GET(new Request("http://test/x"), ctx);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ state: "ready", basis: "sold_comparables" });
    expect((state.args as unknown[])[3]).toMatchObject({ currentPriceCents: 150_000_000, suburb: "Paddington" });
    expect(state.audits[0]).toMatchObject({ eventType: "listing.price_suggestion_shown", payload: { confidence: "medium", evidence: 3 } });
  });
  it("insufficient data is a 200 with no numbers", async () => {
    state.result = { state: "insufficient", message: "m", missing: ["x"], modelVersion: "v", disclaimer: "d" };
    const b = await (await route.GET(new Request("http://test/x"), ctx)).json();
    expect(b).toMatchObject({ state: "insufficient" });
    expect(state.audits[0]!.payload).toEqual({ state: "insufficient", model: "v" });
  });
});
