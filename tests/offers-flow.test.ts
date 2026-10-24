import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/domain/audit";
import {
  createDraft, createInMemoryListingRepository,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import type { Queryable } from "../src/server/db";
import { nextStatus, parseDecision } from "../src/domain/offer-decision";
import { windowStart, withinLimit } from "../src/domain/rate-limit";

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

import { POST as issuePost } from "../app/api/listings/[id]/offer-links/route";
import { POST as decisionPost } from "../app/api/listings/[id]/offers/[offerId]/decision/route";
import { POST as submitPost } from "../app/api/listings/[id]/offers/route";

const owner: Actor = { userId: "owner-1", userType: "owner" };
const agent: Actor = { userId: "agent-1", userType: "agent" };
const vendor = { userId: "vendor-1", userType: "vendor" } as unknown as Actor;
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};
const NOW = "2026-10-24T00:00:00.000Z";
const BUYER = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";

let n: number;
let audit: AuditEvent[];
let calls: { text: string; params: unknown[] }[];
let buyerEligible: boolean;
let offerStatus: string | undefined;
let updateRows: Record<string, unknown>[];
let hits: unknown[];
let storeDown: boolean;
let listingId: string;

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
  buyerEligible = true;
  offerStatus = "submitted";
  updateRows = [{ id: OFFER }];
  hits = [1, 1];
  storeDown = false;
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
      if (text.includes("offer_submit_attempt")) {
        if (storeDown) throw new Error("down");
        return { rows: [{ hits: hits.shift() }] };
      }
      if (text.includes("FROM app_user u JOIN buyer_verification")) return { rows: buyerEligible ? [{ id: BUYER }] : [] };
      if (text.includes("SELECT o.status")) return { rows: offerStatus ? [{ status: offerStatus }] : [] };
      if (text.includes("UPDATE formal_offer")) return { rows: updateRows };
      return { rows: [] };
    }
  };
  listingId = await publishedListing();
});

const json = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
const issue = (id: string, body: unknown) =>
  issuePost(json(`/api/listings/${id}/offer-links`, body), { params: Promise.resolve({ id }) });
const decide = (id: string, offerId: string, body: unknown) =>
  decisionPost(json(`/api/listings/${id}/offers/${offerId}/decision`, body), { params: Promise.resolve({ id, offerId }) });
const submit = (id: string, headers: Record<string, string> = {}) =>
  submitPost(
    json(`/api/listings/${id}/offers`, {
      token: "t".repeat(43), priceCents: 90_000_000, conditions: [], settlementDays: 30, depositCents: 9_000_000, confirmedFinal: true
    }, headers),
    { params: Promise.resolve({ id }) }
  );

describe("offer decision rules", () => {
  it("allows the expected transitions and nothing else", () => {
    expect(nextStatus("submitted", "accept")).toBe("accepted");
    expect(nextStatus("under_review", "reject")).toBe("rejected");
    expect(nextStatus("submitted", "counter_request")).toBe("countered");
    expect(nextStatus("countered", "accept")).toBe("accepted");
    expect(nextStatus("countered", "counter_request")).toBeUndefined();
    for (const done of ["accepted", "rejected", "withdrawn"]) {
      for (const d of ["accept", "reject", "counter_request"] as const) expect(nextStatus(done, d)).toBeUndefined();
    }
  });
  it("parses only the three known decisions", () => {
    expect(parseDecision({ decision: "accept" })).toBe("accept");
    expect(parseDecision({ decision: "auto_accept" })).toBeUndefined();
    expect(parseDecision(null)).toBeUndefined();
  });
  it("rate limit helpers floor to the window and fail closed", () => {
    expect(windowStart("2026-10-24T00:07:30.000Z", 600_000)).toBe("2026-10-24T00:00:00.000Z");
    expect(withinLimit(5, 5)).toBe(true);
    expect(withinLimit(6, 5)).toBe(false);
    expect(withinLimit(undefined, 5)).toBe(false);
    expect(withinLimit(Number.NaN, 5)).toBe(false);
  });
});

describe("POST /api/listings/[id]/offer-links (owner issues a link)", () => {
  it("returns 401 signed out and 403 for agents and other roles", async () => {
    expect((await issue(listingId, { buyerUserId: BUYER })).status).toBe(401);
    for (const a of [agent, vendor]) {
      state.actor = a;
      expect((await issue(listingId, { buyerUserId: BUYER })).status).toBe(403);
    }
  });
  it("returns 404 for another owner, an unknown listing and an unpublished listing", async () => {
    state.actor = { userId: "owner-2", userType: "owner" };
    expect((await issue(listingId, { buyerUserId: BUYER })).status).toBe(404);
    state.actor = owner;
    expect((await issue("missing", { buyerUserId: BUYER })).status).toBe(404);
    const draft = await createDraft(state.deps!, owner, input);
    expect((await issue(draft.id, { buyerUserId: BUYER })).status).toBe(404);
    expect(calls.filter(c => c.text.includes("INSERT INTO offer_link"))).toHaveLength(0);
  });
  it("returns 400 for a missing or malformed buyer id and for a buyer who is not eligible", async () => {
    state.actor = owner;
    expect((await issue(listingId, {})).status).toBe(400);
    expect((await issue(listingId, { buyerUserId: "x'; DROP TABLE app_user;--" })).status).toBe(400);
    buyerEligible = false;
    expect((await issue(listingId, { buyerUserId: BUYER })).status).toBe(400);
    expect(calls.filter(c => c.text.includes("INSERT INTO offer_link"))).toHaveLength(0);
  });
  it("returns 201 with the raw token once, stores only the hash, and audits without the token", async () => {
    state.actor = owner;
    const res = await issue(listingId, { buyerUserId: BUYER });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(typeof body.token).toBe("string");
    expect(body.expiresAt).toBe("2026-10-25T00:00:00.000Z");
    const insert = calls.find(c => c.text.includes("INSERT INTO offer_link"))!;
    expect(insert.params).not.toContain(body.token);
    expect(insert.params[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(insert.params.slice(1, 3)).toEqual([listingId, BUYER]);
    const issued = audit.filter(a => a.eventType === "offer_link.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]!.actorId).toBe("owner-1");
    expect(JSON.stringify(issued[0])).not.toContain(body.token);
    const eligibility = calls.find(c => c.text.includes("buyer_verification"))!;
    expect(eligibility.params).toEqual([BUYER, "owner-1"]);
  });
});

describe("POST /api/listings/[id]/offers/[offerId]/decision (owner decides)", () => {
  it("returns 401 signed out and 403 for agents and other roles", async () => {
    expect((await decide(listingId, OFFER, { decision: "accept" })).status).toBe(401);
    for (const a of [agent, vendor]) {
      state.actor = a;
      expect((await decide(listingId, OFFER, { decision: "accept" })).status).toBe(403);
    }
    expect(calls.filter(c => c.text.includes("UPDATE formal_offer"))).toHaveLength(0);
  });
  it("returns 400 for an unknown decision such as an AI auto accept", async () => {
    state.actor = owner;
    expect((await decide(listingId, OFFER, { decision: "auto_accept" })).status).toBe(400);
    expect((await decide(listingId, OFFER, {})).status).toBe(400);
  });
  it("returns 404 for another owner, an unknown listing, a bad offer id and an offer not on the listing", async () => {
    state.actor = { userId: "owner-2", userType: "owner" };
    expect((await decide(listingId, OFFER, { decision: "reject" })).status).toBe(404);
    state.actor = owner;
    expect((await decide("missing", OFFER, { decision: "reject" })).status).toBe(404);
    expect((await decide(listingId, "not-a-uuid", { decision: "reject" })).status).toBe(404);
    offerStatus = undefined;
    expect((await decide(listingId, OFFER, { decision: "reject" })).status).toBe(404);
    expect(calls.filter(c => c.text.includes("UPDATE formal_offer"))).toHaveLength(0);
  });
  it("returns 409 for a finished offer or when the offer changed during the update", async () => {
    state.actor = owner;
    offerStatus = "accepted";
    expect((await decide(listingId, OFFER, { decision: "reject" })).status).toBe(409);
    offerStatus = "submitted";
    updateRows = [];
    expect((await decide(listingId, OFFER, { decision: "accept" })).status).toBe(409);
    expect(audit.filter(a => a.eventType.startsWith("offer."))).toHaveLength(0);
  });
  it("accepts, rejects and counter-requests, each audited, with the owner id taken from the session", async () => {
    state.actor = owner;
    for (const [decision, status] of [["accept", "accepted"], ["reject", "rejected"], ["counter_request", "countered"]] as const) {
      const res = await decide(listingId, OFFER, { decision, ownerUserId: "attacker", floorPriceCents: 1 });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ offer: { id: OFFER, status } });
      expect(audit.filter(a => a.eventType === `offer.${status}`)).toHaveLength(1);
    }
    const updates = calls.filter(c => c.text.includes("UPDATE formal_offer"));
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u.params).not.toContain("attacker");
      expect(u.params.slice(0, 3)).toEqual([OFFER, listingId, "owner-1"]);
    }
    const sql = updates.map(u => u.text.toLowerCase()).join(" ");
    expect(sql).not.toContain("floor");
    expect(sql).not.toContain("mandate");
    expect(audit.every(a => !JSON.stringify(a).toLowerCase().includes("floor"))).toBe(true);
  });
});

describe("POST /api/listings/[id]/offers rate limiting", () => {
  it("returns 429 once a link has too many attempts, before looking up the link", async () => {
    hits = [6, 1];
    const res = await submit(listingId, { "x-forwarded-for": "203.0.113.5" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
    expect(calls.filter(c => c.text.includes("FROM offer_link WHERE"))).toHaveLength(0);
  });
  it("returns 429 once an IP has too many attempts", async () => {
    hits = [1, 21];
    expect((await submit(listingId, { "x-forwarded-for": "203.0.113.5" })).status).toBe(429);
  });
  it("counts hits against hashed buckets, never the raw IP or token", async () => {
    await submit(listingId, { "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    const counted = calls.filter(c => c.text.includes("offer_submit_attempt"));
    expect(counted).toHaveLength(2);
    for (const c of counted) {
      expect(c.params[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(c.params[1]).toBe("2026-10-24T00:00:00.000Z");
      expect(JSON.stringify(c.params)).not.toContain("203.0.113.5");
      expect(JSON.stringify(c.params)).not.toContain("ttttt");
    }
  });
  it("fails closed with 503 when the counter store errors or returns nothing usable", async () => {
    storeDown = true;
    expect((await submit(listingId)).status).toBe(503);
    storeDown = false;
    hits = [undefined, 1];
    expect((await submit(listingId)).status).toBe(429);
    expect(audit.filter(a => a.eventType === "offer.submitted")).toHaveLength(0);
  });
});
