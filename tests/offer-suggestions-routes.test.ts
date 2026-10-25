import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rulesOnlyEngine, type AiEnginePort } from "../src/domain/ai-engine";

const O = "77777777-7777-4777-8777-777777777777";
const state = vi.hoisted(() => ({ handler: null as unknown, engine: null as unknown, hits: 1 as number, inserted: [] as unknown[], audits: [] as { eventType: string; payload: Record<string, unknown> }[] }));
vi.mock("../src/server/context", () => ({
  getDb: () => ({}),
  getDeps: () => ({ now: () => "2026-10-25T02:00:00.000Z", newId: () => crypto.randomUUID(), appendAudit: async (e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); } })
}));
vi.mock("../src/server/owner-listing", () => ({ requireListingHandler: async () => state.handler }));
vi.mock("../src/server/offers-db", () => ({
  offersForOwnerPg: async () => [{ id: "77777777-7777-4777-8777-777777777777", priceCents: 80_000_000, depositCents: 8_000_000, settlementDays: 30, conditions: [], status: "submitted", submittedAt: "2026-10-25T01:00:00.000Z" }]
}));
vi.mock("../src/server/offer-suggestions-db", () => ({ sameBuyerOffersPg: async () => [], enquiryForOfferPg: async () => "55555555-5555-4555-8555-555555555555" }));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/ai-records-db", () => ({ createPgAiDraftRepository: () => ({ insert: async (d: unknown) => { state.inserted.push(d); } }) }));
vi.mock("../src/server/ai", () => ({ getAiEngine: async () => state.engine }));
vi.mock("../src/server/wording-filter", () => ({ getWordingFilter: () => () => ({ blocked: false, flags: [], installed: true }) }));

import * as route from "../app/api/listings/[id]/offers/[offerId]/ai/suggestions/route";

const ctx = (offerId = O) => ({ params: Promise.resolve({ id: "L1", offerId }) });
const post = () => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: "{}" });
const owner = { actor: { userId: "owner-1", userType: "owner" }, rec: { listing: { id: "L1", ownerUserId: "owner-1", transactionType: "sale", priceCents: 90_000_000 } }, asAgent: false };
const ai: AiEnginePort = { info: () => ({ id: "ollama:t", kind: "self_hosted", version: "1" }), readDocument: async () => "", describePhoto: async () => [], generate: async () => "Thanks for your offer." };

beforeEach(() => { process.env["APP_URL"] = "http://test"; state.handler = owner; state.engine = rulesOnlyEngine; state.hits = 1; state.inserted = []; state.audits = []; });

describe("offer suggestions route", () => {
  it("passes through the 401/404 of the listing check, and 404 for an unknown offer", async () => {
    state.handler = NextResponse.json({ error: "Sign in required." }, { status: 401 });
    expect((await route.POST(post(), ctx())).status).toBe(401);
    state.handler = owner;
    expect((await route.POST(post(), ctx("88888888-8888-4888-8888-888888888888"))).status).toBe(404);
    expect((await route.POST(post(), ctx("bad"))).status).toBe(404);
  });
  it("AI off: 200 with the analysis and no drafts", async () => {
    const b = await (await route.POST(post(), ctx())).json();
    expect(b).toMatchObject({ aiAvailable: false, drafts: [], canSendInThread: true });
    expect(b.analysis.counter.amountCents).toBe(84_000_000);
    expect(state.audits[0]?.eventType).toBe("offer.ai_suggestions_requested");
  });
  it("AI on: drafts are stored and returned without the footer; never an accept", async () => {
    state.engine = ai;
    const b = await (await route.POST(post(), ctx())).json();
    expect(b.drafts.map((d: { action: string }) => d.action)).toEqual(["recommend_counter", "request_information", "reject"]);
    expect(b.drafts[0].text).toBe("Thanks for your offer.");
    expect(state.inserted).toHaveLength(3);
  });
  it("is rate limited", async () => {
    state.hits = 21;
    expect((await route.POST(post(), ctx())).status).toBe(429);
  });
});
