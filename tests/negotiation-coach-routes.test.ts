import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL } from "../src/domain/negotiation-coach";

const O = "77777777-7777-4777-8777-777777777777";
const O2 = "66666666-6666-4666-8666-666666666666";
const state = vi.hoisted(() => ({ handler: null as unknown, hits: 1 as number, inserted: [] as { text: string; status: string; action: string }[], audits: [] as { eventType: string; payload: Record<string, unknown> }[], filterInstalled: true }));
vi.mock("../src/server/context", () => ({
  getDb: () => ({}),
  getDeps: () => ({ now: () => "2026-10-25T02:00:00.000Z", newId: () => crypto.randomUUID(), appendAudit: async (e: { eventType: string; payload: Record<string, unknown> }) => { state.audits.push(e); } })
}));
vi.mock("../src/server/owner-listing", () => ({ requireListingHandler: async () => state.handler }));
vi.mock("../src/server/offers-db", () => ({
  offersForOwnerPg: async () => [
    { id: "77777777-7777-4777-8777-777777777777", priceCents: 80_000_000, depositCents: 8_000_000, settlementDays: 30, conditions: [], status: "submitted", submittedAt: "2026-10-25T01:00:00.000Z" },
    { id: "66666666-6666-4666-8666-666666666666", priceCents: 79_000_000, depositCents: 7_900_000, settlementDays: 60, conditions: ["Subject to finance"], status: "submitted", submittedAt: "2026-10-25T01:30:00.000Z" }
  ]
}));
vi.mock("../src/server/offer-suggestions-db", () => ({ sameBuyerOffersPg: async () => [], enquiryForOfferPg: async () => "55555555-5555-4555-8555-555555555555" }));
vi.mock("../src/server/offer-flow-db", () => ({ countHitPg: async () => state.hits }));
vi.mock("../src/server/mandate-db", () => ({ mandateHistoryPg: async () => [] }));
vi.mock("../src/server/negotiation-coach-db", () => ({ currentModelPg: async () => DEFAULT_MODEL, latestOwnerCounterCentsPg: async () => undefined }));
vi.mock("../src/server/ai-records-db", () => ({ createPgAiDraftRepository: () => ({ insert: async (d: { text: string; status: string; action: string }) => { state.inserted.push(d); } }) }));
vi.mock("../src/server/wording-filter", () => ({ getWordingFilter: () => () => ({ blocked: false, flags: [], installed: state.filterInstalled }) }));

import * as coachRoute from "../app/api/listings/[id]/offers/[offerId]/coach/route";
import * as parseRoute from "../app/api/listings/[id]/coach/parse/route";

const ctx = (offerId = O) => ({ params: Promise.resolve({ id: "L1", offerId }) });
const pctx = { params: Promise.resolve({ id: "L1" }) };
const post = (body: unknown = {}) => new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test" }, body: JSON.stringify(body) });
const owner = { actor: { userId: "owner-1", userType: "owner" }, rec: { listing: { id: "L1", ownerUserId: "owner-1", transactionType: "sale", priceCents: 90_000_000 } }, asAgent: false };

beforeEach(() => { process.env["APP_URL"] = "http://test"; state.handler = owner; state.hits = 1; state.inserted = []; state.audits = []; state.filterInstalled = true; });

describe("offer coach route", () => {
  it("passes through the 401/404 of the listing check, and 404 for an unknown or malformed offer", async () => {
    state.handler = NextResponse.json({ error: "Sign in required." }, { status: 401 });
    expect((await coachRoute.POST(post(), ctx())).status).toBe(401);
    state.handler = owner;
    expect((await coachRoute.POST(post(), ctx("88888888-8888-4888-8888-888888888888"))).status).toBe(404);
    expect((await coachRoute.POST(post(), ctx("bad"))).status).toBe(404);
  });
  it("returns scenarios, risk, strategy over both open offers, and stored templates; never an accept", async () => {
    const b = await (await coachRoute.POST(post(), ctx())).json();
    expect(b.scenarios.map((s: { key: string }) => s.key)).toEqual(["firm", "balanced", "quick"]);
    expect(b.risk.level).toBeDefined();
    expect(b.strategy.ranking.map((r: { label: string }) => r.label).sort()).toEqual(["Offer A", "Offer B"]);
    expect(b.canSendInThread).toBe(true);
    expect(b.templates.map((t: { kind: string }) => t.kind)).toEqual(["counter_firm", "counter_balanced", "counter_quick", "best_and_final", "request_information", "holding_message", "decline_politely"]);
    expect(state.inserted).toHaveLength(7);
    expect(state.inserted.every(d => d.status === "pending")).toBe(true);
    expect(state.inserted.some(d => /accept/i.test(d.action))).toBe(false);
    expect(b.templates[0].text).not.toMatch(/drafted with AI/);
    expect(state.audits[0]).toMatchObject({ eventType: "offer.coach_requested" });
  });
  it("holds templates when the wording filter is not installed, so they must be edited before sending", async () => {
    state.filterInstalled = false;
    const b = await (await coachRoute.POST(post(), ctx())).json();
    expect(b.templates.every((t: { status: string }) => t.status === "held")).toBe(true);
  });
  it("mentions other offers only when the seller opts in", async () => {
    const off = await (await coachRoute.POST(post(), ctx())).json();
    expect(off.templates.find((t: { kind: string }) => t.kind === "best_and_final").text).not.toMatch(/other offers/);
    const on = await (await coachRoute.POST(post({ mentionOtherOffers: true }), ctx())).json();
    const t = on.templates.find((x: { kind: string }) => x.kind === "best_and_final");
    expect(t.text).toMatch(/other offers/);
    expect(t.status).toBe("pending");
  });
  it("does not leak the other offer's terms into this offer's templates", async () => {
    const b = await (await coachRoute.POST(post(), ctx(O))).json();
    expect(JSON.stringify(b.templates)).not.toContain("790,000");
  });
  it("is rate limited", async () => {
    state.hits = 61;
    expect((await coachRoute.POST(post(), ctx())).status).toBe(429);
  });
});

describe("paste-an-offer route", () => {
  it("reads the text and coaches on it without storing anything", async () => {
    const b = await (await parseRoute.POST(post({ text: "We offer $850,000, 10% deposit, 45 day settlement, subject to finance. Final offer, expires tomorrow." }), pctx)).json();
    expect(b.parsed).toMatchObject({ priceCents: 85_000_000, depositPercent: 10, settlementDays: 45, conditions: ["Subject to finance"] });
    expect(b.parsed.pressure.length).toBe(2);
    expect(b.coach.scenarios.length).toBeGreaterThan(0);
    expect(b.coach.redFlags.some((f: { code: string }) => f.code === "pressure")).toBe(true);
    expect(state.inserted).toHaveLength(0);
  });
  it("says what is missing when there is no price, and rejects empty or oversized text", async () => {
    const b = await (await parseRoute.POST(post({ text: "Is the house still available this weekend?" }), pctx)).json();
    expect(b.coach).toBeNull();
    expect(b.parsed.missing).toContain("price");
    expect((await parseRoute.POST(post({ text: "hi" }), pctx)).status).toBe(400);
    expect((await parseRoute.POST(post({ text: "x".repeat(4001) }), pctx)).status).toBe(400);
    expect((await parseRoute.POST(post({}), pctx)).status).toBe(400);
  });
  it("is rate limited", async () => {
    state.hits = 61;
    expect((await parseRoute.POST(post({ text: "$850,000 offer" }), pctx)).status).toBe(429);
  });
});
