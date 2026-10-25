import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiEnginePort } from "../src/domain/ai-engine";
import { createInMemoryAiDraftRepository } from "../src/domain/ai-draft-record";
import { AI_FOOTER } from "../src/domain/ai-pipeline";
import { createInMemoryDraftRepository } from "../src/domain/enquiry-drafts";
import { createInMemoryEnquiryRepository, type EnquiryDeps } from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import { discardReplyDraft, requestReplyDraft, sendReplyDraft, type AiReplyDeps } from "../src/server/ai-reply";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as unknown }));
vi.mock("../src/server/context", () => ({ getActor: async () => state.actor }));
vi.mock("../src/server/ai-reply", async orig => ({ ...(await orig<typeof import("../src/server/ai-reply")>()), getAiReplyDeps: async () => state.deps }));
import * as draftRoute from "../app/api/enquiries/[id]/ai/draft/route";
import * as sendRoute from "../app/api/ai/drafts/[draftId]/send/route";
import * as discardRoute from "../app/api/ai/drafts/[draftId]/discard/route";

const L = "11111111-1111-4111-8111-111111111111";
const E = "55555555-5555-4555-8555-555555555555";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const buyer: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "buyer" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "owner" };
const clean = () => ({ blocked: false, flags: [], installed: true });
let reply = "Yes, it is still available.";
const engine: AiEnginePort = {
  info: () => ({ id: "ollama:test", kind: "self_hosted", version: "1" }), readDocument: async () => "", describePhoto: async () => [],
  generate: async () => reply
};

let deps: AiReplyDeps & { drafts: ReturnType<typeof createInMemoryAiDraftRepository> };
let enquiryDeps: EnquiryDeps;
let hits = 1;
const audits: string[] = [];
let n = 0;
beforeEach(async () => {
  reply = "Yes, it is still available."; hits = 1; audits.length = 0; n = 0;
  const listings = createInMemoryListingRepository();
  await listings.insert({
    listing: { id: L, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Home", propertyType: "house",
      useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [], createdAt: "", updatedAt: "", priceCents: 85_000_000 },
    listingFeePaid: true, termsAccepted: true
  });
  const enquiries = createInMemoryEnquiryRepository();
  await enquiries.insert({ id: E, listingId: L, buyerUserId: buyer.userId, createdAt: "" });
  await enquiries.addMessage({ id: "m1", enquiryId: E, senderUserId: buyer.userId, automated: false, body: "Is it still available?", sentAt: "2026-10-25T01:00:00.000Z" });
  enquiryDeps = {
    enquiries, listings, drafts: createInMemoryDraftRepository(() => owner.userId),
    verification: async () => ({ emailVerified: true, phoneVerified: true, idVerified: true }), termsCurrentFor: async () => true,
    countHit: async () => hits, offerRequestUrl: () => "", appendAudit: async e => { audits.push(e.eventType); },
    now: () => "2026-10-25T02:00:00.000Z", newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
  deps = { enquiry: enquiryDeps, drafts: createInMemoryAiDraftRepository(), engine: async () => engine, wordingFilter: clean, aiPaused: async () => false };
  state.deps = deps;
});

describe("AI reply service", () => {
  it("drafts for the owner only; the buyer and strangers get not_found", async () => {
    for (const a of [buyer, stranger]) expect((await requestReplyDraft(deps, a, E)).ok).toBe(false);
    const r = await requestReplyDraft(deps, owner, E);
    expect(r.ok && r.value.state).toBe("drafted");
    expect(deps.drafts.rows).toHaveLength(1);
    expect(audits).toEqual(["enquiry.ai_draft_requested"]);
  });
  it("is rate limited, failing closed", async () => {
    hits = 31;
    expect(await requestReplyDraft(deps, owner, E)).toMatchObject({ ok: false, code: "rate_limited" });
    hits = undefined as unknown as number;
    expect(await requestReplyDraft(deps, owner, E)).toMatchObject({ ok: false, code: "rate_limited" });
  });
  it("send as is posts the draft with the footer into the thread, once", async () => {
    const r = await requestReplyDraft(deps, owner, E);
    const id = r.ok && r.value.state === "drafted" ? r.value.draft.id : "";
    expect((await sendReplyDraft(deps, buyer, id, "as_is", undefined)).ok).toBe(false);
    const s = await sendReplyDraft(deps, owner, id, "as_is", undefined);
    expect(s.ok).toBe(true);
    const msgs = await enquiryDeps.enquiries.messages(E);
    expect(msgs.at(-1)?.body.endsWith(AI_FOOTER)).toBe(true);
    expect(msgs.at(-1)?.senderUserId).toBe(owner.userId);
    expect(deps.drafts.rows[0]?.status).toBe("sent");
    expect(await sendReplyDraft(deps, owner, id, "as_is", undefined)).toMatchObject({ ok: false, code: "conflict" });
    expect(await discardReplyDraft(deps, owner, id)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("a held draft cannot go as is; edited text that passes can", async () => {
    reply = "We accept your offer!";
    const r = await requestReplyDraft(deps, owner, E);
    const id = r.ok && r.value.state === "drafted" ? r.value.draft.id : "";
    expect(deps.drafts.rows[0]?.status).toBe("held");
    const bad = await sendReplyDraft(deps, owner, id, "as_is", undefined);
    expect(bad.ok === false && "violations" in bad && bad.violations.map(v => v.code)).toContain("binding_language");
    expect((await sendReplyDraft(deps, owner, id, "edited", "Thanks, the seller will reply about the offer process.")).ok).toBe(true);
    expect(deps.drafts.rows[0]?.status).toBe("edited_sent");
  });
  it("discard keeps the record", async () => {
    const r = await requestReplyDraft(deps, owner, E);
    const id = r.ok && r.value.state === "drafted" ? r.value.draft.id : "";
    expect((await discardReplyDraft(deps, stranger, id)).ok).toBe(false);
    expect((await discardReplyDraft(deps, owner, id)).ok).toBe(true);
    expect(deps.drafts.rows[0]?.status).toBe("discarded");
  });
});

describe("AI reply routes", () => {
  const H = { "content-type": "application/json", origin: "http://test" };
  const post = (body: unknown) => new Request("http://test/x", { method: "POST", headers: H, body: JSON.stringify(body) });
  beforeEach(() => { process.env["APP_URL"] = "http://test"; state.actor = null; });
  it("draft route: 401, 404 for the buyer, then a draft without the footer for editing", async () => {
    expect((await draftRoute.POST(post({}), { params: Promise.resolve({ id: E }) })).status).toBe(401);
    state.actor = buyer;
    expect((await draftRoute.POST(post({}), { params: Promise.resolve({ id: E }) })).status).toBe(404);
    state.actor = owner;
    const b = await (await draftRoute.POST(post({}), { params: Promise.resolve({ id: E }) })).json();
    expect(b).toMatchObject({ state: "drafted", intent: "availability", draft: { text: "Yes, it is still available.", status: "pending" } });
  });
  it("send route validates the body and returns 422 with reasons for a held draft", async () => {
    state.actor = owner;
    reply = "It's a deal.";
    const b = await (await draftRoute.POST(post({}), { params: Promise.resolve({ id: E }) })).json();
    const ctx = { params: Promise.resolve({ draftId: b.draft.id }) };
    expect((await sendRoute.POST(post({ mode: "auto" }), ctx)).status).toBe(400);
    expect((await sendRoute.POST(post({ mode: "edited" }), ctx)).status).toBe(400);
    const r = await sendRoute.POST(post({ mode: "as_is" }), ctx);
    expect(r.status).toBe(422);
    expect((await r.json()).violations[0].code).toBe("binding_language");
    expect((await discardRoute.POST(post({}), ctx)).status).toBe(200);
  });
});
