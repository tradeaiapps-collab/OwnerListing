import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/domain/audit";
import {
  createDraft, createInMemoryListingRepository,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import type { Queryable } from "../src/server/db";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  deps: null as ListingServiceDeps | null,
  db: null as Queryable | null
}));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps,
  getDb: () => state.db
}));

import { POST as ownerCounter } from "../app/api/listings/[id]/offers/[offerId]/counter/route";
import { GET as ownerDetail } from "../app/api/listings/[id]/offers/[offerId]/route";
import { GET as myOffers } from "../app/api/offers/route";
import { GET as myOffer } from "../app/api/offers/[offerId]/route";
import { POST as buyerCounter } from "../app/api/offers/[offerId]/counter/route";
import { POST as buyerAgree } from "../app/api/offers/[offerId]/agree/route";
import { POST as buyerWithdraw } from "../app/api/offers/[offerId]/withdraw/route";
process.env["APP_URL"] = "http://test";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const otherOwner: Actor = { userId: "owner-2", userType: "owner" };
const agent: Actor = { userId: "agent-1", userType: "agent" };
const buyer: Actor = { userId: "buyer-9", userType: "buyer" };
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};
const NOW = "2026-10-25T00:00:00.000Z";
const OFFER = "22222222-2222-4222-8222-222222222222";
const COUNTER = "33333333-3333-4333-8333-333333333333";

let n: number;
let audit: AuditEvent[];
let calls: { text: string; params: unknown[] }[];
let listingId: string;
let termsOk: boolean;
let buyerEligible: boolean;
let offerStatus: string;
let writeOk: boolean;
let counters: Record<string, unknown>[];

const ownerRow = () => ({ id: OFFER, status: offerStatus, submitted_at: NOW, price_cents: 90_000_000, conditions: ["Finance approval"], settlement_days: 42, deposit_cents: 9_000_000, round: 0 });
const buyerRow = () => ({ id: OFFER, listing_id: listingId, title: "Family home", status: offerStatus, submitted_at: NOW, price_cents: 90_000_000, conditions: [], settlement_days: 42, deposit_cents: 9_000_000 });

beforeEach(async () => {
  n = 0; audit = []; calls = []; termsOk = true; buyerEligible = true; offerStatus = "submitted"; writeOk = true; counters = [];
  state.actor = null;
  state.deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async e => { audit.push(e); },
    now: () => NOW,
    newId: () => `id-${++n}`,
    requiredDisclosures: () => [],
    termsCurrentFor: async () => termsOk
  };
  state.db = {
    async query(text, params) {
      const p = params ?? [];
      calls.push({ text, params: p });
      if (text.includes("SET status = 'expired'")) return { rows: [] };
      if (text.includes("FROM app_user u JOIN buyer_verification")) return { rows: buyerEligible ? [{ id: p[0] }] : [] };
      if (text.includes("INSERT INTO offer_counter")) return { rows: writeOk ? [{ id: COUNTER, round: 1 }] : [] };
      if (text.includes("SET status = 'agreed'") || text.includes("SET status = 'withdrawn'")) return { rows: writeOk ? [{ id: OFFER }] : [] };
      if (text.includes("FROM offer_counter WHERE offer_id")) return { rows: counters };
      if (text.includes("WHERE o.buyer_user_id = $1")) return { rows: p[0] === "buyer-9" ? [buyerRow()] : [] };
      if (text.includes("FROM formal_offer o JOIN property_listing l")) return { rows: p[1] === "owner-1" ? [ownerRow()] : [] };
      return { rows: [] };
    }
  };
  const draft = await createDraft(state.deps!, owner, input);
  const rec = (await state.deps!.repo.get(draft.id))!;
  await state.deps!.repo.save({ ...rec, listing: { ...rec.listing, status: "published" } });
  listingId = draft.id;
  audit = [];
});

const post = (url: string, body: unknown, origin = "http://test") =>
  new Request(`http://test${url}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`http://test${url}`);
const terms = (o: Record<string, unknown> = {}) => ({ priceCents: 95_000_000, depositCents: 9_500_000, settlementDays: 30, conditions: ["Finance approval"], ...o });
const counterAsOwner = (body: unknown, offerId = OFFER) =>
  ownerCounter(post(`/api/listings/${listingId}/offers/${offerId}/counter`, body), { params: Promise.resolve({ id: listingId, offerId }) });
const writes = () => calls.filter(c => c.text.includes("INSERT INTO offer_counter") || c.text.includes("SET status = 'agreed'") || c.text.includes("SET status = 'withdrawn'"));

describe("POST /api/listings/[id]/offers/[offerId]/counter (owner counters)", () => {
  it("refuses a cross-site request, no session, non-owners and agents, without writing", async () => {
    state.actor = owner;
    expect((await ownerCounter(post(`/api/listings/${listingId}/offers/${OFFER}/counter`, terms(), "http://evil"), { params: Promise.resolve({ id: listingId, offerId: OFFER }) })).status).toBe(403);
    state.actor = null;
    expect((await counterAsOwner(terms())).status).toBe(401);
    state.actor = agent;
    expect((await counterAsOwner(terms())).status).toBe(403);
    state.actor = buyer;
    expect((await counterAsOwner(terms())).status).toBe(403);
    state.actor = otherOwner;
    expect((await counterAsOwner(terms())).status).toBe(404);
    state.actor = owner;
    expect((await counterAsOwner(terms(), "not-a-uuid")).status).toBe(404);
    expect(writes()).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
  it("validates the terms", async () => {
    state.actor = owner;
    for (const bad of [terms({ priceCents: 0 }), terms({ depositCents: 100_000_000 }), terms({ settlementDays: 400 }), terms({ expiresInDays: 15 }),
      terms({ conditions: Array(11).fill("x") }), terms({ priceCents: "95000000" })]) {
      expect((await counterAsOwner(bad)).status).toBe(400);
    }
    // Same as the buyer's standing terms: that is accepting, not countering.
    expect((await counterAsOwner(terms({ priceCents: 90_000_000, depositCents: 9_000_000, settlementDays: 42 }))).status).toBe(400);
    expect(writes()).toHaveLength(0);
  });
  it("records the counter with the owner id from the session and audits it", async () => {
    state.actor = owner;
    const res = await counterAsOwner({ ...terms(), ownerUserId: "attacker", expiresInDays: 2 });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ offer: { id: OFFER, status: "countered" }, counter: { id: COUNTER, round: 1 } });
    const w = writes()[0]!;
    expect(w.params.slice(0, 3)).toEqual([OFFER, listingId, "owner-1"]);
    expect(w.params).not.toContain("attacker");
    expect(w.params[8]).toBe("2026-10-27T00:00:00.000Z");
    expect(audit.map(a => [a.eventType, a.actorId])).toEqual([["offer.countered", "owner-1"]]);
  });
  it("returns 409 when it is not the owner's turn", async () => {
    state.actor = owner;
    writeOk = false;
    expect((await counterAsOwner(terms())).status).toBe(409);
    expect(audit).toHaveLength(0);
  });
});

describe("GET /api/listings/[id]/offers/[offerId] (owner detail)", () => {
  it("shows the offer and counters to the owner with no buyer identity, and 404 to other owners", async () => {
    counters = [{ id: COUNTER, round: 1, from_party: "owner", price_cents: 95_000_000, conditions: [], settlement_days: 30, deposit_cents: 0, status: "open", created_at: NOW, expires_at: NOW, closed_at: null }];
    state.actor = owner;
    const res = await ownerDetail(get(`/api/listings/${listingId}/offers/${OFFER}`), { params: Promise.resolve({ id: listingId, offerId: OFFER }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offer.awaiting).toBe("owner");
    expect(body.counters.map((c: { fromParty: string }) => c.fromParty)).toEqual(["owner"]);
    expect(body.canDecide).toBe(true);
    expect(body.timeline).toEqual([]);
    expect(calls.some(c => c.text.includes("FROM offer_event WHERE offer_id = $1") && c.params[0] === OFFER)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("buyer-9");
    state.actor = otherOwner;
    expect((await ownerDetail(get(`/x`), { params: Promise.resolve({ id: listingId, offerId: OFFER }) })).status).toBe(404);
  });
});

describe("buyer routes", () => {
  const counterAsBuyer = (body: unknown) => buyerCounter(post(`/api/offers/${OFFER}/counter`, body), { params: Promise.resolve({ offerId: OFFER }) });
  const agree = (body: unknown) => buyerAgree(post(`/api/offers/${OFFER}/agree`, body), { params: Promise.resolve({ offerId: OFFER }) });
  const withdraw = () => buyerWithdraw(post(`/api/offers/${OFFER}/withdraw`, {}), { params: Promise.resolve({ offerId: OFFER }) });

  it("lists and shows only the buyer's own offers; everyone else gets 404", async () => {
    state.actor = buyer;
    const list = await myOffers(get("/api/offers"));
    expect((await list.json()).offers.map((o: { id: string }) => o.id)).toEqual([OFFER]);
    expect((await myOffer(get(`/api/offers/${OFFER}`), { params: Promise.resolve({ offerId: OFFER }) })).status).toBe(200);
    for (const a of [owner, agent, { userId: "buyer-8", userType: "buyer" } as Actor]) {
      state.actor = a;
      expect((await myOffer(get(`/api/offers/${OFFER}`), { params: Promise.resolve({ offerId: OFFER }) })).status).toBe(404);
    }
    state.actor = owner;
    expect((await myOffers(get("/api/offers"))).status).toBe(404);
    state.actor = null;
    expect((await myOffers(get("/api/offers"))).status).toBe(401);
  });
  it("lets the buyer counter only on their turn, with current terms and verification", async () => {
    state.actor = buyer;
    expect((await counterAsBuyer(terms())).status).toBe(409); // still "submitted": the owner has not countered
    offerStatus = "countered";
    termsOk = false;
    expect((await counterAsBuyer(terms())).status).toBe(403);
    termsOk = true;
    buyerEligible = false;
    expect((await counterAsBuyer(terms())).status).toBe(403);
    buyerEligible = true;
    expect(writes()).toHaveLength(0);
    const res = await counterAsBuyer({ ...terms(), buyerUserId: "buyer-8" });
    expect(res.status).toBe(201);
    expect(writes()[0]!.params[2]).toBe("buyer-9");
    expect(audit.map(a => [a.eventType, a.actorId])).toEqual([["offer.buyer_countered", "buyer-9"]]);
  });
  it("refuses a buyer counter that just repeats the owner's open counter", async () => {
    state.actor = buyer;
    offerStatus = "countered";
    counters = [{ id: COUNTER, round: 1, from_party: "owner", price_cents: 95_000_000, conditions: ["Finance approval"], settlement_days: 30, deposit_cents: 9_500_000, status: "open", created_at: NOW, expires_at: NOW, closed_at: null }];
    expect((await counterAsBuyer(terms())).status).toBe(400);
  });
  it("agree needs a counter id and the buyer's turn; it never accepts the offer", async () => {
    state.actor = buyer;
    offerStatus = "countered";
    expect((await agree({})).status).toBe(400);
    writeOk = false;
    expect((await agree({ counterId: COUNTER })).status).toBe(409);
    writeOk = true;
    const res = await agree({ counterId: COUNTER });
    expect(await res.json()).toEqual({ offer: { id: OFFER, status: "buyer_countered" } });
    expect(audit.map(a => a.eventType)).toEqual(["offer.buyer_agreed"]);
    expect(calls.some(c => /SET status = 'accepted'/.test(c.text))).toBe(false);
  });
  it("withdraw works for the buyer and is refused once closed", async () => {
    state.actor = buyer;
    expect((await withdraw()).status).toBe(200);
    writeOk = false;
    expect((await withdraw()).status).toBe(409);
    state.actor = owner;
    expect((await withdraw()).status).toBe(404);
    expect(audit.map(a => a.eventType)).toEqual(["offer.withdrawn"]);
  });
});
