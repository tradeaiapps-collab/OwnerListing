import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDraftRepository } from "../src/domain/enquiry-drafts";
import { createInMemoryEnquiryRepository, type EnquiryDeps } from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";

const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as EnquiryDeps | null }));

vi.mock("../src/server/context", () => ({ getActor: () => state.actor }));
vi.mock("../src/server/enquiry-db", () => ({ getEnquiryDeps: () => state.deps }));

import * as inboxRoute from "../app/api/enquiries/route";
import * as threadRoute from "../app/api/enquiries/[id]/messages/route";
import * as draftsRoute from "../app/api/enquiries/drafts/route";
import * as draftRoute from "../app/api/enquiries/drafts/[id]/route";
import * as settingsRoute from "../app/api/enquiries/auto-reply/route";
import * as startRoute from "../app/api/listings/[id]/enquiries/route";
process.env["APP_URL"] = "http://test";

const L = "11111111-1111-4111-8111-111111111111";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const buyer: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "buyer" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "buyer" };
const full = { emailVerified: true, phoneVerified: true, idVerified: true };

let n = 0;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method, headers: { "content-type": "application/json", origin: "http://test", ...headers }, body: JSON.stringify(body) });

let termsOk = true;
beforeEach(async () => {
  termsOk = true;
  state.actor = null;
  n = 0;
  const listings = createInMemoryListingRepository();
  await listings.insert({
    listing: {
      id: L, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Home", propertyType: "house",
      useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
      createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z"
    },
    listingFeePaid: true, termsAccepted: true
  });
  state.deps = {
    enquiries: createInMemoryEnquiryRepository(), listings, drafts: createInMemoryDraftRepository(() => owner.userId),
    verification: async id => (id === buyer.userId ? full : { emailVerified: true, phoneVerified: false, idVerified: false }),
    termsCurrentFor: async () => termsOk, countHit: async () => 1, offerRequestUrl: id => `http://test/enquiries/${id}`, appendAudit: async () => {},
    now: () => "2026-10-24T00:00:00.000Z",
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`
  };
});

const begin = (body: unknown = { body: "Is it available?" }, headers?: Record<string, string>) =>
  startRoute.POST(json("POST", `http://test/api/listings/${L}/enquiries`, body, headers), ctx(L));

describe("enquiry routes", () => {
  it("export only the intended methods: no PUT, PATCH or DELETE anywhere", () => {
    expect(Object.keys(threadRoute).sort()).toEqual(["GET", "POST"]);
    expect(Object.keys(inboxRoute)).toEqual(["GET"]);
    expect(Object.keys(startRoute)).toEqual(["POST"]);
    expect(Object.keys(draftsRoute)).toEqual(["GET"]);
    expect(Object.keys(draftRoute)).toEqual(["POST"]);
    expect(Object.keys(settingsRoute).sort()).toEqual(["GET", "POST"]);
  });
  it("returns 401 when signed out", async () => {
    expect((await begin()).status).toBe(401);
    expect((await inboxRoute.GET(new Request("http://test/api/enquiries"))).status).toBe(401);
    expect((await draftsRoute.GET(new Request("http://test/api/enquiries/drafts"))).status).toBe(401);
  });
  it("applies the CSRF guard to every state-changing route", async () => {
    state.actor = buyer;
    const bad = { origin: "http://evil.test" };
    expect((await begin(undefined, bad)).status).toBe(403);
    expect((await threadRoute.POST(json("POST", "http://test/x", { body: "x" }, bad), ctx(L))).status).toBe(403);
    expect((await draftRoute.POST(json("POST", "http://test/x", { action: "send" }, bad), ctx(L))).status).toBe(403);
    expect((await settingsRoute.POST(json("POST", "http://test/x", { paused: true }, bad))).status).toBe(403);
  });
  it("denies an unverified buyer with 403 and creates no thread", async () => {
    state.actor = stranger;
    expect((await begin()).status).toBe(403);
    expect(((await (await inboxRoute.GET(new Request("http://test/api/enquiries"))).json()) as { items: unknown[] }).items).toEqual([]);
  });
  it("lets a verified buyer and the owner converse, and hides the thread from others (404)", async () => {
    state.actor = buyer;
    const started = await begin();
    expect(started.status).toBe(201);
    const id = ((await started.json()) as { enquiry: { id: string } }).enquiry.id;
    state.actor = owner;
    expect((await threadRoute.POST(json("POST", "http://test/x", { body: "Yes" }), ctx(id))).status).toBe(201);
    const read = await threadRoute.GET(new Request("http://test/x"), ctx(id));
    expect(((await read.json()) as { messages: { body: string }[] }).messages.map(m => m.body)).toEqual(["Is it available?", "Yes"]);
    state.actor = stranger;
    expect((await threadRoute.GET(new Request("http://test/x"), ctx(id))).status).toBe(404);
    expect((await threadRoute.POST(json("POST", "http://test/x", { body: "hi" }), ctx(id))).status).toBe(404);
    expect((await threadRoute.GET(new Request("http://test/x"), ctx("nope"))).status).toBe(404);
  });
  it("denies starting or replying to an enquiry until the current terms are accepted, and stores nothing", async () => {
    state.actor = buyer;
    const started = await begin();
    const id = ((await started.json()) as { enquiry: { id: string } }).enquiry.id;
    termsOk = false;
    expect((await begin()).status).toBe(403);
    for (const a of [buyer, owner]) {
      state.actor = a;
      expect((await threadRoute.POST(json("POST", "http://test/x", { body: "hi" }), ctx(id))).status).toBe(403);
    }
    termsOk = true;
    const read = await threadRoute.GET(new Request("http://test/x"), ctx(id));
    expect(((await read.json()) as { messages: unknown[] }).messages).toHaveLength(1);
  });
  it("returns 429 when the buyer is over the limit", async () => {
    state.actor = buyer;
    state.deps = { ...state.deps!, countHit: async () => 999 };
    expect((await begin()).status).toBe(429);
  });
  it("keeps drafts and auto-reply settings owner-only", async () => {
    state.actor = buyer;
    expect((await draftsRoute.GET(new Request("http://test/x"))).status).toBe(403);
    expect((await settingsRoute.GET(new Request("http://test/x"))).status).toBe(403);
    expect((await settingsRoute.POST(json("POST", "http://test/x", { paused: true }))).status).toBe(403);
    expect((await draftRoute.POST(json("POST", "http://test/x", { action: "send" }), ctx(L))).status).toBe(403);
    state.actor = owner;
    expect((await settingsRoute.POST(json("POST", "http://test/x", { enabled: true, paused: true }))).status).toBe(200);
    expect((await draftRoute.POST(json("POST", "http://test/x", { action: "explode" }), ctx(L))).status).toBe(400);
    expect((await draftRoute.POST(json("POST", "http://test/x", { action: "send" }), ctx(L))).status).toBe(404);
  });
});

describe("db/20261024140000_enquiries_chat.sql", () => {
  const sql = readFileSync(new URL("../db/20261024140000_enquiries_chat.sql", import.meta.url), "utf8");
  it("makes enquiry_message permanent with a trigger on UPDATE and DELETE", () => {
    expect(sql).toMatch(/CREATE TRIGGER enquiry_message_no_update_delete\s+BEFORE UPDATE OR DELETE ON enquiry_message/);
  });
  it("is never mutated by the app SQL", () => {
    const code = readFileSync(new URL("../src/server/enquiry-db.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/(UPDATE|DELETE FROM)\s+enquiry_message/i);
  });
});
