import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "../src/domain/negotiation-coach";

const O = "77777777-7777-4777-8777-777777777777";
const L = "11111111-1111-4111-8111-111111111111";
const state = vi.hoisted(() => ({ handler: null as unknown, actor: null as unknown, hits: 1 as number, audits: [] as { eventType: string; payload: Record<string, unknown> }[], saved: [] as unknown[], owns: true }));
vi.mock("../src/server/context", () => ({
  getDb: () => ({}),
  getActor: async () => state.actor,
  getDeps: () => ({ now: () => "2026-11-20T02:00:00.000Z", newId: () => crypto.randomUUID(), appendAudit: async (e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); } })
}));
vi.mock("../src/server/owner-listing", () => ({ requireListingHandler: async () => state.handler }));
vi.mock("../src/server/offers-db", () => ({
  offersForOwnerPg: async () => [
    { id: O, priceCents: 80_000_000, depositCents: 8_000_000, settlementDays: 30, conditions: [], status: "submitted", submittedAt: "2026-11-19T01:00:00.000Z", round: 0 },
    { id: "66666666-6666-4666-8666-666666666666", priceCents: 79_123_400, depositCents: 7_900_000, settlementDays: 60, conditions: ["Subject to finance"], status: "submitted", submittedAt: "2026-11-19T01:30:00.000Z", round: 0, openCounter: { id: "c", priceCents: 1, depositCents: 1, settlementDays: 1, conditions: [], expiresAt: "2026-11-25T00:00:00.000Z" } },
    { id: "55555555-5555-4555-8555-555555555555", priceCents: 70_000_000, depositCents: 1, settlementDays: 30, conditions: [], status: "rejected", submittedAt: "2026-11-18T01:30:00.000Z", round: 0 }
  ]
}));
vi.mock("../src/server/prequalification-db", () => ({ prequalsForListing: async () => [{ offerId: O, priceCents: 80_000_000, prequal: { state: "verified", label: "✓ Verified", approvedCents: 90_000_000, expiresAt: "2027-01-01T00:00:00.000Z" } }] }));
vi.mock("../src/server/offer-counter-db", () => ({ expireCountersPg: async () => 0 }));
vi.mock("../src/server/offer-suggestions-db", () => ({ sameBuyerOffersPg: async () => [], enquiryForOfferPg: async () => undefined }));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/mandate-db", () => ({ mandateHistoryPg: async () => [] }));
vi.mock("../src/server/negotiation-coach-db", () => ({ currentModelPg: async () => DEFAULT_MODEL, latestOwnerCounterCentsPg: async () => undefined }));
vi.mock("../src/server/sale-paperwork-db", () => ({
  loadPaperwork: async () => ({ items: [], summary: {}, saleInProgress: false }),
  paperworkView: async () => ({ items: [], summary: { done: 0, total: 0, blockers: [], later: [], recommended: [], readyForSettlement: false, headline: "x" }, saleInProgress: false, chase: false, chases: [], log: [], note: "n" }),
  saveChaseSetting: async (_db: unknown, userId: string, _id: string, chase: boolean) => { state.saved.push([userId, chase]); return state.owns; }
}));

import * as compareRoute from "../app/api/listings/[id]/offers/compare/route";
import * as draftRoute from "../app/api/listings/[id]/offers/[offerId]/counter-draft/route";
import * as paperRoute from "../app/api/listings/[id]/paperwork/route";

const ctx = { params: Promise.resolve({ id: L }) };
const dctx = (offerId = O) => ({ params: Promise.resolve({ id: L, offerId }) });
const get = () => new Request("http://test/x");
const send = (method: string, body: unknown = {}, origin = "http://test") => new Request("http://test/x", { method, headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
const owner = { actor: { userId: "owner-1", userType: "owner" }, rec: { listing: { id: L, ownerUserId: "owner-1", transactionType: "sale", priceCents: 90_000_000, address: "1 Test St" } }, asAgent: false };
const agent = { ...owner, actor: { userId: "agent-1", userType: "agent" }, asAgent: true };

beforeEach(() => { process.env["APP_URL"] = "http://test"; state.handler = owner; state.actor = owner.actor; state.hits = 1; state.audits = []; state.saved = []; state.owns = true; });

describe("GET offers/compare", () => {
  it("passes the listing check through: anonymous 401, stranger 404", async () => {
    state.handler = NextResponse.json({ error: "Sign in required." }, { status: 401 });
    expect((await compareRoute.GET(get(), ctx)).status).toBe(401);
    state.handler = NextResponse.json({ error: "Listing not found." }, { status: 404 });
    expect((await compareRoute.GET(get(), ctx)).status).toBe(404);
  });
  it("compares only the open offers, as A and B, with finance and reply-by, and no identity", async () => {
    const b = await (await compareRoute.GET(get(), ctx)).json();
    expect(b.columns.map((c: { label: string }) => c.label)).toEqual(["Offer A", "Offer B"]);
    expect(b.columns[0].finance).toBe("verified");
    expect(b.columns[1].replyBy).toBe("2026-11-25T00:00:00.000Z");
    expect(b.listing).toEqual({ id: L, address: "1 Test St", transactionType: "sale", askingPriceCents: 90_000_000 });
    expect(JSON.stringify(b)).not.toMatch(/buyerUserId|buyer_user|floor|email/i);
    expect(state.audits[0]).toMatchObject({ eventType: "offer.compare_viewed", payload: { offers: 2, asAgent: false } });
  });
  it("is rate limited and never cached", async () => {
    const ok = await compareRoute.GET(get(), ctx);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    state.hits = 9999;
    expect((await compareRoute.GET(get(), ctx)).status).toBe(429);
  });
});

describe("POST counter-draft", () => {
  it("needs the CSRF origin, a real offer id and the listing check", async () => {
    expect((await draftRoute.POST(send("POST", {}, "http://evil.example"), dctx())).status).toBe(403);
    expect((await draftRoute.POST(send("POST"), dctx("bad"))).status).toBe(404);
    expect((await draftRoute.POST(send("POST"), dctx("88888888-8888-4888-8888-888888888888"))).status).toBe(404);
    state.handler = NextResponse.json({ error: "Listing not found." }, { status: 404 });
    expect((await draftRoute.POST(send("POST"), dctx())).status).toBe(404);
  });
  it("returns editable terms that pass the counter rules, plus the other styles; nothing is sent or accepted", async () => {
    const b = await (await draftRoute.POST(send("POST"), dctx())).json();
    expect(b.draft.terms.priceCents).toBeGreaterThan(0);
    expect(b.draft.terms.depositCents).toBeLessThanOrEqual(b.draft.terms.priceCents);
    expect(b.draft.terms.expiresInDays).toBeGreaterThanOrEqual(1);
    expect(b.alternatives.map((a: { key: string }) => a.key)).toEqual(["firm", "balanced", "quick"]);
    expect(b.note).toMatch(/Nothing is sent or accepted until you press send/);
    expect(b.sendNote).toBe("");
    expect(JSON.stringify(b)).not.toMatch(/accept(ed)? your offer|floor/i);
    expect(state.audits[0]).toMatchObject({ eventType: "offer.counter_drafted" });
  });
  it("picks the style asked for, and does not leak the other offer's terms into this draft", async () => {
    const firm = await (await draftRoute.POST(send("POST", { scenario: "firm" }), dctx())).json();
    expect(firm.draft.scenario).toBe("firm");
    expect(JSON.stringify(firm)).not.toMatch(/79,?123,?400|791234/);
  });
  it("an appointed agent may see the draft but is told only the owner can send", async () => {
    state.handler = agent;
    const b = await (await draftRoute.POST(send("POST"), dctx())).json();
    expect(b.draft).not.toBeNull();
    expect(b.sendNote).toMatch(/Only the owner/);
  });
  it("is rate limited", async () => {
    state.hits = 9999;
    expect((await draftRoute.POST(send("POST"), dctx())).status).toBe(429);
  });
});

describe("paperwork route", () => {
  it("GET: owner or agent only, and an agent cannot change it", async () => {
    const o = await (await paperRoute.GET(get(), ctx)).json();
    expect(o.canChange).toBe(true);
    state.handler = agent;
    expect((await (await paperRoute.GET(get(), ctx)).json()).canChange).toBe(false);
    state.handler = NextResponse.json({ error: "Sign in required." }, { status: 401 });
    expect((await paperRoute.GET(get(), ctx)).status).toBe(401);
    expect((await paperRoute.GET(get(), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
  });
  it("PUT: CSRF, sign-in, boolean body, and the owner check lives in the save", async () => {
    expect((await paperRoute.PUT(send("PUT", { chase: true }, "http://evil.example"), ctx)).status).toBe(403);
    state.actor = null;
    expect((await paperRoute.PUT(send("PUT", { chase: true }), ctx)).status).toBe(401);
    state.actor = owner.actor;
    expect((await paperRoute.PUT(send("PUT", { chase: "yes" }), ctx)).status).toBe(400);
    expect((await paperRoute.PUT(send("PUT", { chase: true }), ctx)).status).toBe(200);
    expect(state.saved).toEqual([["owner-1", true]]);
    state.owns = false;
    expect((await paperRoute.PUT(send("PUT", { chase: true }), ctx)).status).toBe(404);
  });
});
