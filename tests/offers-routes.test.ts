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

import { GET as offersGet, POST as offersPost } from "../app/api/listings/[id]/offers/route";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const agent: Actor = { userId: "agent-1", userType: "agent" };
const vendor = { userId: "vendor-1", userType: "vendor" } as unknown as Actor;
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};
const NOW = "2026-10-24T00:00:00.000Z";
const TOKEN = "t".repeat(43);

let n: number;
let audit: AuditEvent[];
let calls: { text: string; params: unknown[] }[];
let linkRow: Record<string, unknown> | undefined;
let spendRows: Record<string, unknown>[];
let offerRows: Record<string, unknown>[];
let listingId: string;

const goodLink = () => ({
  token_hash: "h".repeat(64), listing_id: listingId, buyer_user_id: "buyer-9",
  expires_at: "2026-10-25T00:00:00.000Z", used_at: null
});
const goodBody = () => ({
  token: TOKEN, priceCents: 90_000_000, conditions: ["Finance approval"], settlementDays: 30, depositCents: 9_000_000, confirmedFinal: true
});

async function publishedListing(): Promise<string> {
  const draft = await createDraft(state.deps!, owner, input);
  const rec = (await state.deps!.repo.get(draft.id))!;
  await state.deps!.repo.save({ ...rec, listing: { ...rec.listing, status: "published" } });
  return draft.id;
}

beforeEach(async () => {
  n = 0;
  audit = [];
  calls = [];
  state.actor = null;
  state.deps = {
    repo: createInMemoryListingRepository(),
    appendAudit: async e => { audit.push(e); },
    now: () => NOW,
    newId: () => `id-${++n}`,
    requiredDisclosures: () => []
  };
  state.db = {
    async query(text, params) {
      calls.push({ text, params: params ?? [] });
      if (text.includes("FROM offer_link WHERE")) return { rows: linkRow ? [linkRow] : [] };
      if (text.includes("WITH spent")) return { rows: spendRows };
      if (text.includes("FROM formal_offer o")) return { rows: offerRows };
      return { rows: [] };
    }
  };
  listingId = await publishedListing();
  linkRow = goodLink();
  spendRows = [{ id: "offer-1", submitted_at: NOW }];
  offerRows = [];
});

const submit = (id: string, body: unknown) =>
  offersPost(
    new Request(`http://test/api/listings/${id}/offers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );
const review = (id: string) =>
  offersGet(new Request(`http://test/api/listings/${id}/offers`), { params: Promise.resolve({ id }) });

describe("POST /api/listings/[id]/offers (buyer submits)", () => {
  it("returns 400 for a missing token or a non-object body", async () => {
    expect((await submit(listingId, { ...goodBody(), token: undefined })).status).toBe(400);
    expect((await submit(listingId, null)).status).toBe(400);
  });
  it("returns 400 unless the buyer confirms the offer is final", async () => {
    expect((await submit(listingId, { ...goodBody(), confirmedFinal: false })).status).toBe(400);
  });
  it("returns 404 for an unknown or unpublished listing", async () => {
    expect((await submit("missing", goodBody())).status).toBe(404);
    const draft = await createDraft(state.deps!, owner, input);
    expect((await submit(draft.id, goodBody())).status).toBe(404);
  });
  it("returns 400 for an unknown token", async () => {
    linkRow = undefined;
    expect((await submit(listingId, goodBody())).status).toBe(400);
  });
  it("returns 400 for a used, expired or other-listing link", async () => {
    linkRow = { ...goodLink(), used_at: "2026-10-23T12:00:00.000Z" };
    expect((await submit(listingId, goodBody())).status).toBe(400);
    linkRow = { ...goodLink(), expires_at: "2026-10-23T00:00:00.000Z" };
    expect((await submit(listingId, goodBody())).status).toBe(400);
    linkRow = { ...goodLink(), listing_id: "another-listing" };
    expect((await submit(listingId, goodBody())).status).toBe(400);
  });
  it("returns 400 when the deposit is more than the price", async () => {
    expect((await submit(listingId, { ...goodBody(), depositCents: 90_000_001 })).status).toBe(400);
  });
  it("returns 409 when the link was spent by a concurrent request", async () => {
    spendRows = [];
    expect((await submit(listingId, goodBody())).status).toBe(409);
    expect(audit.filter(a => a.eventType === "offer.submitted")).toHaveLength(0);
  });
  it("returns 201, takes the buyer from the link (not the body), audits, and spends the link in one statement", async () => {
    const res = await submit(listingId, { ...goodBody(), buyerUserId: "attacker" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ offer: { id: "offer-1", submittedAt: NOW } });
    const spend = calls.filter(c => c.text.includes("WITH spent"));
    expect(spend).toHaveLength(1);
    expect(spend[0]!.params).not.toContain("attacker");
    expect(spend[0]!.params).toContain(listingId);
    const submitted = audit.filter(a => a.eventType === "offer.submitted");
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.actorId).toBe("buyer-9");
  });
});

describe("GET /api/listings/[id]/offers (owner reviews)", () => {
  it("returns 401 when signed out and 403 for other roles", async () => {
    expect((await review(listingId)).status).toBe(401);
    state.actor = vendor;
    expect((await review(listingId)).status).toBe(403);
  });
  it("returns 404 for another owner, an agent and an unknown listing", async () => {
    for (const a of [{ userId: "owner-2", userType: "owner" } as Actor, agent]) {
      state.actor = a;
      expect((await review(listingId)).status).toBe(404);
    }
    state.actor = owner;
    expect((await review("missing")).status).toBe(404);
    expect(calls.filter(c => c.text.includes("FROM formal_offer o"))).toHaveLength(0);
  });
  it("returns the owner's offers with no buyer identity or mandate fields", async () => {
    offerRows = [{
      id: "offer-1", price_cents: "90000000", conditions: ["Finance approval"], settlement_days: 30,
      deposit_cents: "9000000", status: "submitted", submitted_at: NOW, buyer_user_id: "buyer-9", floor_price_cents: 1
    }];
    state.actor = owner;
    const res = await review(listingId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offers).toEqual([{
      id: "offer-1", priceCents: 90_000_000, conditions: ["Finance approval"], settlementDays: 30,
      depositCents: 9_000_000, status: "submitted", submittedAt: NOW
    }]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("buyer-9");
    expect(text.toLowerCase()).not.toContain("floor");
    const q = calls.find(c => c.text.includes("FROM formal_offer o"))!;
    expect(q.params).toEqual([listingId, "owner-1"]);
  });
});
