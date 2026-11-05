import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDraftRepository } from "../src/domain/enquiry-drafts";
import { createInMemoryEnquiryRepository, type EnquiryDeps } from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({
  actor: null as Actor | null, deps: null as EnquiryDeps | null, staff: null as { id: string; role: string } | null,
  reviewed: [] as string[], audits: [] as string[], lastAction: "", lastNote: null as string | null
}));
vi.mock("../src/server/context", () => ({ getActor: async () => state.actor, getStaff: async () => state.staff, getDb: () => ({}) }));
vi.mock("../src/server/enquiry-db", () => ({ getEnquiryDeps: () => state.deps }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/message-moderation-db", () => ({
  MODERATION_ACTIONS: ["approve", "request_revision", "educate"],
  moderationFlagsForEnquiryPg: async () => [{ messageId: "m1", status: "educated", reviewNote: "Avoid off-platform promises", flags: [{ category: "off_platform_promise", explanation: "why", suggestion: "do this" }] }],
  moderationQueuePg: async () => [{ id: "f1", senderName: "Sam", severity: "high" }],
  reviewModerationFlagPg: async (_d: unknown, id: string, _by: string, action: string, note: string | null) => {
    if (state.reviewed.includes(id)) return false;
    state.reviewed.push(id); state.lastAction = action; state.lastNote = note; return true;
  }
}));

import * as thread from "../app/api/enquiries/[id]/moderation/route";
import * as queue from "../app/api/staff/moderation/route";
import * as review from "../app/api/staff/moderation/[id]/route";

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
  state.actor = null; state.staff = null; state.reviewed = []; state.audits = [];
  const listings = createInMemoryListingRepository();
  await listings.insert({
    listing: { id: L, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Home", propertyType: "house",
      useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [], createdAt: "", updatedAt: "" },
    listingFeePaid: true, termsAccepted: true
  });
  const enquiries = createInMemoryEnquiryRepository();
  await enquiries.insert({ id: E, listingId: L, buyerUserId: buyer.userId, createdAt: "" });
  await enquiries.addMessage({ id: "m0", enquiryId: E, senderUserId: owner.userId, automated: false, body: "Hello", sentAt: "2026-10-25T00:00:00.000Z" });
  state.deps = {
    enquiries, listings, drafts: createInMemoryDraftRepository(), verification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }),
    termsCurrentFor: async () => true, countHit: async () => 1, offerRequestUrl: () => "", appendAudit: async () => {},
    now: () => "2026-11-05T00:00:00.000Z", newId: () => "id"
  };
});

describe("thread moderation route", () => {
  it("seller side gets templates, a stalled note and staff feedback; the buyer and strangers get 404", async () => {
    expect((await thread.GET(req("GET"), ctx(E))).status).toBe(401);
    state.actor = owner;
    const b = await (await thread.GET(req("GET"), ctx(E))).json();
    expect(b.templates.length).toBeGreaterThan(4);
    expect(b.insight.stalled).toMatchObject({ waitingOn: "buyer" });
    expect(b.feedback[0]).toMatchObject({ status: "educated", note: "Avoid off-platform promises" });
    for (const a of [buyer, stranger]) {
      state.actor = a;
      expect((await thread.GET(req("GET"), ctx(E))).status).toBe(404);
      expect((await thread.POST(req("POST", { body: "x" }), ctx(E))).status).toBe(404);
    }
    state.actor = owner;
    expect((await thread.GET(req("GET"), ctx("nope"))).status).toBe(404);
  });
  it("checks a draft: flags it with softer versions, passes a clean one, validates input and CSRF", async () => {
    state.actor = owner;
    const bad = await (await thread.POST(req("POST", { body: "Take it or leave it. This is ridiculous, the price is firm. WhatsApp me." }), ctx(E))).json();
    expect(bad.risk).toBe("high");
    expect(bad.rewrites.length).toBe(4);
    const one = await (await thread.POST(req("POST", { body: "Are you serious? A joke.", tone: "firm" }), ctx(E))).json();
    expect(one.rewrites).toHaveLength(1);
    const clean = await (await thread.POST(req("POST", { body: "Thanks for the offer." }), ctx(E))).json();
    expect(clean).toMatchObject({ risk: "none", rewrites: [] });
    expect((await thread.POST(req("POST", { body: "" }), ctx(E))).status).toBe(400);
    expect((await thread.POST(req("POST", { body: "x", tone: "rude" }), ctx(E))).status).toBe(400);
    expect((await thread.POST(new Request("http://test/x", { method: "POST", headers: { ...H, origin: "http://evil" }, body: "{}" }), ctx(E))).status).toBe(403);
  });
});

describe("staff moderation", () => {
  it("queue needs case.manage", async () => {
    expect((await queue.GET(req("GET"))).status).toBe(401);
    state.staff = { id: owner.userId, role: "designer" };
    expect((await queue.GET(req("GET"))).status).toBe(403);
    state.staff = { id: owner.userId, role: "support" };
    expect((await (await queue.GET(req("GET"))).json()).flags).toHaveLength(1);
  });
  it("review validates, needs a note to revise or educate, happens once and is audited", async () => {
    state.staff = { id: owner.userId, role: "compliance" };
    expect((await review.POST(req("POST", { action: "ban" }), ctx(F))).status).toBe(400);
    expect((await review.POST(req("POST", { action: "request_revision" }), ctx(F))).status).toBe(400);
    expect((await review.POST(req("POST", { action: "educate", note: "" }), ctx(F))).status).toBe(400);
    expect((await review.POST(req("POST", { action: "approve" }), ctx("x"))).status).toBe(404);
    expect((await review.POST(req("POST", { action: "educate", note: "Keep deals on the platform" }), ctx(F))).status).toBe(200);
    expect(state.lastAction).toBe("educate");
    expect((await review.POST(req("POST", { action: "approve" }), ctx(F))).status).toBe(409);
    expect(state.audits).toContain("moderation_flag.reviewed");
  });
});
