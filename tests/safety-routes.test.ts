import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredSafetyFlag } from "../src/domain/ai-draft-record";
import { createInMemoryDraftRepository } from "../src/domain/enquiry-drafts";
import { createInMemoryEnquiryRepository, type EnquiryDeps } from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import { scanInboundMessage } from "../src/domain/message-safety";

const state = vi.hoisted(() => ({
  actor: null as Actor | null, deps: null as EnquiryDeps | null, staff: null as { id: string; role: string } | null,
  flags: [] as StoredSafetyFlag[], paused: false, reviews: [] as string[], audits: [] as string[]
}));
vi.mock("../src/server/context", () => ({ getActor: async () => state.actor, getStaff: async () => state.staff, getDb: () => ({}) }));
vi.mock("../src/server/enquiry-db", () => ({ getEnquiryDeps: () => state.deps }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/ai-records-db", () => ({
  safetyFlagsForEnquiryPg: async () => state.flags,
  aiPausedPg: async () => ({ paused: state.paused }),
  setAiPausePg: async (_db: unknown, _id: string, p: boolean) => { state.paused = p; },
  safetyQueuePg: async () => state.flags.map(f => ({ ...f, body: "msg", listingId: "L" })),
  reviewSafetyFlagPg: async (_db: unknown, id: string) => { if (state.reviews.includes(id)) return false; state.reviews.push(id); return true; }
}));

import * as safety from "../app/api/enquiries/[id]/safety/route";
import * as queue from "../app/api/staff/safety-flags/route";
import * as review from "../app/api/staff/safety-flags/[id]/route";

const L = "11111111-1111-4111-8111-111111111111";
const E = "55555555-5555-4555-8555-555555555555";
const F = "66666666-6666-4666-8666-666666666666";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const buyer: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "buyer" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const H = { "content-type": "application/json", origin: "http://test" };
const req = (method: string, body?: unknown) => new Request("http://test/x", { method, headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(async () => {
  process.env["APP_URL"] = "http://test";
  state.actor = null; state.staff = null; state.paused = true; state.reviews = []; state.audits = [];
  const r = scanInboundMessage("Send the deposit to my account");
  state.flags = [{ id: F, enquiryId: E, messageId: "m1", risk: "high", flags: r.flags, handoff: true, staffReview: true, createdAt: "2026-10-25T00:00:00.000Z" }];
  const listings = createInMemoryListingRepository();
  await listings.insert({
    listing: { id: L, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Home", propertyType: "house",
      useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [], createdAt: "", updatedAt: "" },
    listingFeePaid: true, termsAccepted: true
  });
  const enquiries = createInMemoryEnquiryRepository();
  await enquiries.insert({ id: E, listingId: L, buyerUserId: buyer.userId, createdAt: "" });
  state.deps = {
    enquiries, listings, drafts: createInMemoryDraftRepository(), verification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }),
    termsCurrentFor: async () => true, countHit: async () => 1, offerRequestUrl: () => "", appendAudit: async e => { state.audits.push(e.eventType); },
    now: () => "2026-10-25T00:00:00.000Z", newId: () => "id"
  };
});

describe("thread safety route", () => {
  it("the owner sees warnings and the AI pause; the buyer sees nothing; strangers get 404", async () => {
    expect((await safety.GET(req("GET"), ctx(E))).status).toBe(401);
    state.actor = owner;
    const b = await (await safety.GET(req("GET"), ctx(E))).json();
    expect(b.aiPaused).toBe(true);
    expect(b.flags[0]).toMatchObject({ messageId: "m1", risk: "high" });
    expect(b.flags[0].reasons[0].category).toBe("payment_redirect");
    expect(b.note).toMatch(/never holds money/);
    state.actor = buyer;
    expect(await (await safety.GET(req("GET"), ctx(E))).json()).toMatchObject({ flags: [], aiPaused: false });
    state.actor = stranger;
    expect((await safety.GET(req("GET"), ctx(E))).status).toBe(404);
    expect((await safety.GET(req("GET"), ctx("not-a-uuid"))).status).toBe(404);
  });
  it("only the owner can resume the AI, with a valid action and CSRF", async () => {
    state.actor = buyer;
    expect((await safety.POST(req("POST", { action: "resume_ai" }), ctx(E))).status).toBe(404);
    state.actor = owner;
    expect((await safety.POST(req("POST", { action: "nope" }), ctx(E))).status).toBe(400);
    expect((await safety.POST(new Request("http://test/x", { method: "POST", headers: { ...H, origin: "http://evil" }, body: "{}" }), ctx(E))).status).toBe(403);
    expect(state.paused).toBe(true);
    expect((await safety.POST(req("POST", { action: "resume_ai" }), ctx(E))).status).toBe(200);
    expect(state.paused).toBe(false);
    expect(state.audits).toContain("enquiry.ai_resumed");
  });
});

describe("staff safety queue", () => {
  it("needs case.manage", async () => {
    expect((await queue.GET(req("GET"))).status).toBe(401);
    state.staff = { id: owner.userId, role: "designer" };
    expect((await queue.GET(req("GET"))).status).toBe(403);
    state.staff = { id: owner.userId, role: "support" };
    expect((await (await queue.GET(req("GET"))).json()).flags).toHaveLength(1);
  });
  it("review validates input, happens once and is audited", async () => {
    state.staff = { id: owner.userId, role: "compliance" };
    expect((await review.POST(req("POST", { outcome: "maybe" }), ctx(F))).status).toBe(400);
    expect((await review.POST(req("POST", { outcome: "confirmed", note: "" }), ctx(F))).status).toBe(400);
    expect((await review.POST(req("POST", { outcome: "confirmed" }), ctx("x"))).status).toBe(404);
    expect((await review.POST(req("POST", { outcome: "confirmed", note: "Redirect scam" }), ctx(F))).status).toBe(200);
    expect((await review.POST(req("POST", { outcome: "dismissed" }), ctx(F))).status).toBe(409);
    expect(state.audits).toContain("safety_flag.reviewed");
  });
});
