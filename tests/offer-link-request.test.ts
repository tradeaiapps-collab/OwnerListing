import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../src/domain/audit";
import type { BuyerVerification } from "../src/domain/buyer";
import { createInMemoryDraftRepository } from "../src/domain/enquiry-drafts";
import { createInMemoryEnquiryRepository, startEnquiry } from "../src/domain/enquiry-service";
import { createInMemoryListingRepository, type Actor } from "../src/domain/listing-service";
import {
  createInMemoryOfferLinkRepository, declineOfferLinkFromThread, issueOfferLinkFromThread, offerLinkState, requestOfferLink,
  type OfferLinkDeps
} from "../src/domain/offer-link-request";
import { hashToken } from "../src/domain/offer-intake";

const KEY = Buffer.alloc(32, 7).toString("base64");
const state = vi.hoisted(() => ({ actor: null as Actor | null, deps: null as OfferLinkDeps | null }));
vi.mock("../src/server/context", () => ({ getActor: async () => state.actor }));
vi.mock("../src/server/enquiry-db", () => ({ getOfferLinkDeps: () => state.deps }));

import * as route from "../app/api/enquiries/[id]/offer-link/route";
process.env["APP_URL"] = "http://test";

const L = "11111111-1111-4111-8111-111111111111";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "55555555-5555-4555-8555-555555555555", userType: "agent" };
const buyer: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "buyer" };
const stranger: Actor = { userId: "44444444-4444-4444-8444-444444444444", userType: "buyer" };
const full: BuyerVerification = { emailVerified: true, phoneVerified: true, idVerified: true };

let n: number;
let clock: number;
let audit: AuditEvent[];
let verification: Record<string, BuyerVerification>;
let eligible: Set<string>;
let enquiries: ReturnType<typeof createInMemoryEnquiryRepository>;
let deps: OfferLinkDeps;
let enquiryId: string;

beforeEach(async () => {
  n = 0;
  clock = Date.parse("2026-10-24T00:00:00Z");
  audit = [];
  verification = { [buyer.userId]: full, [stranger.userId]: full };
  eligible = new Set([buyer.userId, stranger.userId]);
  const listings = createInMemoryListingRepository();
  await listings.insert({
    listing: {
      id: L, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Home", propertyType: "house",
      useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [],
      createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z"
    },
    listingFeePaid: true, termsAccepted: true
  });
  enquiries = createInMemoryEnquiryRepository();
  deps = {
    enquiries, listings, drafts: createInMemoryDraftRepository(() => owner.userId),
    verification: async id => verification[id] ?? { emailVerified: false, phoneVerified: false, idVerified: false },
    countHit: async () => 1, offerRequestUrl: id => `http://test/enquiries/${id}`,
    appendAudit: async e => { audit.push(e); },
    now: () => new Date(clock).toISOString(),
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`,
    offerLinks: createInMemoryOfferLinkRepository(KEY),
    eligibleBuyer: async b => eligible.has(b),
    termsCurrentFor: async () => true
  };
  state.deps = deps;
  state.actor = null;
  const s = await startEnquiry(deps, buyer, L, "Is it available?");
  if (!s.ok) throw new Error(s.message);
  enquiryId = s.value.enquiry.id;
});

describe("buyer requests, owner issues", () => {
  it("runs request, issue, then shows the single-use link to the buyer only", async () => {
    expect(await requestOfferLink(deps, buyer, enquiryId)).toMatchObject({ ok: true, value: { status: "requested" } });
    expect(await issueOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: true });

    const b = await offerLinkState(deps, buyer, enquiryId);
    expect(b).toMatchObject({ ok: true, value: { role: "buyer", request: { status: "issued" }, link: { listingId: L } } });
    const o = await offerLinkState(deps, owner, enquiryId);
    expect(o).toMatchObject({ ok: true, value: { role: "owner", request: { status: "issued" } } });
    expect(o.ok && o.value.link).toBeUndefined();

    // The link is real: its hash is what a later submit would look up.
    const token = b.ok && b.value.link ? b.value.link.token : "";
    expect(token.length).toBeGreaterThan(20);
    expect(await hashToken(token)).toHaveLength(64);
  });
  it("records append-only thread messages and audit events, and never an automated or accepting message", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    await issueOfferLinkFromThread(deps, owner, enquiryId);
    const msgs = (enquiries as unknown as { messagesAll: { automated: boolean; senderUserId: string | null; body: string }[] }).messagesAll;
    expect(msgs).toHaveLength(3);
    expect(msgs.every(m => !m.automated && m.senderUserId !== null)).toBe(true);
    expect(msgs.some(m => /accept/i.test(m.body.replace(/approved your request/i, "")))).toBe(false);
    expect(audit.map(e => e.eventType)).toEqual(expect.arrayContaining(["offer_link.requested", "offer_link.issued"]));
    expect(JSON.stringify(audit)).not.toMatch(/"token"/);
  });
  it("refuses to issue when the server key is unset, and stores nothing", async () => {
    const keyless = { ...deps, offerLinks: createInMemoryOfferLinkRepository(undefined) };
    await requestOfferLink(keyless, buyer, enquiryId);
    expect(await issueOfferLinkFromThread(keyless, owner, enquiryId)).toMatchObject({ ok: false, code: "unavailable" });
    expect((await keyless.offerLinks.latest(enquiryId))?.status).toBe("requested");
  });
  it("stops showing the link once it expires", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    await issueOfferLinkFromThread(deps, owner, enquiryId);
    clock += 25 * 60 * 60 * 1000;
    const b = await offerLinkState(deps, buyer, enquiryId);
    expect(b.ok && b.value.link).toBeUndefined();
  });
  it("lets the owner decline, and a declined request can be asked again", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await declineOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: true });
    expect(await issueOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: false, code: "conflict" });
    expect(await requestOfferLink(deps, buyer, enquiryId)).toMatchObject({ ok: true });
  });
});

describe("denials", () => {
  it("rejects a second request while one is open", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await requestOfferLink(deps, buyer, enquiryId)).toMatchObject({ ok: false, code: "conflict" });
  });
  it("denies request by the owner, an agent or another buyer (not_found for non-parties)", async () => {
    expect(await requestOfferLink(deps, owner, enquiryId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await requestOfferLink(deps, stranger, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await requestOfferLink(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("re-checks buyer verification on request, issue and token read", async () => {
    verification[buyer.userId] = { ...full, idVerified: false };
    expect(await requestOfferLink(deps, buyer, enquiryId)).toMatchObject({ ok: false, code: "forbidden" });
    verification[buyer.userId] = full;
    await requestOfferLink(deps, buyer, enquiryId);

    eligible.delete(buyer.userId);
    expect(await issueOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: false, code: "invalid" });
    eligible.add(buyer.userId);
    verification[buyer.userId] = { ...full, phoneVerified: false };
    expect(await issueOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: false, code: "invalid" });
    verification[buyer.userId] = full;
    await issueOfferLinkFromThread(deps, owner, enquiryId);

    verification[buyer.userId] = { ...full, emailVerified: false };
    const lost = await offerLinkState(deps, buyer, enquiryId);
    expect(lost.ok && lost.value.link).toBeUndefined();
  });
  it("denies issue and decline to buyers, agents and non-parties, and when nothing was requested", async () => {
    expect(await issueOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: false, code: "conflict" });
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await issueOfferLinkFromThread(deps, buyer, enquiryId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await declineOfferLinkFromThread(deps, buyer, enquiryId)).toMatchObject({ ok: false, code: "forbidden" });
    // An agent who is not appointed to this listing is not a party to the thread: same 404 as a missing thread.
    expect(await issueOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await declineOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    const otherOwner: Actor = { userId: "66666666-6666-4666-8666-666666666666", userType: "owner" };
    expect(await issueOfferLinkFromThread(deps, otherOwner, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await offerLinkState(deps, stranger, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("fails closed when the rate counter errors or is over the limit", async () => {
    deps.countHit = async () => 999;
    expect(await requestOfferLink(deps, buyer, enquiryId)).toMatchObject({ ok: false, code: "rate_limited" });
    deps.countHit = async () => { throw new Error("store down"); };
    expect(await requestOfferLink(deps, buyer, enquiryId)).toMatchObject({ ok: false, code: "rate_limited" });
    deps.countHit = async () => 1;
    await requestOfferLink(deps, buyer, enquiryId);
    deps.countHit = async () => undefined;
    expect(await issueOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: false, code: "rate_limited" });
  });
  it("the hourly notice guard rejects a racing second notice in the same UTC hour but allows the next hour", async () => {
    const notice = (id: string, at: string) => ({ id, enquiryId, senderUserId: null, automated: true, body: "notice", sentAt: at });
    expect(await enquiries.addNotice(notice("a", "2026-10-24T00:05:00.000Z"))).toBe(true);
    expect(await enquiries.addNotice(notice("b", "2026-10-24T00:05:00.000Z"))).toBe(false);
    expect(await enquiries.addNotice(notice("c", "2026-10-24T00:59:59.000Z"))).toBe(false);
    expect(await enquiries.addNotice(notice("d", "2026-10-24T01:05:00.000Z"))).toBe(true);
  });
});

describe("POST/GET /api/enquiries/[id]/offer-link", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const post = (action: unknown, headers: Record<string, string> = {}) =>
    new Request("http://test/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://test", ...headers }, body: JSON.stringify({ action }) });

  it("runs csrfGuard before anything else", async () => {
    state.actor = buyer;
    expect((await route.POST(post("request", { origin: "http://evil.test" }), ctx(enquiryId))).status).toBe(403);
    expect((await route.POST(post("request", { "content-type": "text/plain" }), ctx(enquiryId))).status).toBe(403);
    state.actor = null;
    expect((await route.POST(post("request", { origin: "http://evil.test" }), ctx(enquiryId))).status).toBe(403);
    expect((await deps.offerLinks.latest(enquiryId))).toBeUndefined();
  });
  it("requires sign in, a valid id and a known action", async () => {
    expect((await route.POST(post("request"), ctx(enquiryId))).status).toBe(401);
    expect((await route.GET(new Request("http://test/x"), ctx(enquiryId))).status).toBe(401);
    state.actor = buyer;
    expect((await route.POST(post("request"), ctx("nope"))).status).toBe(404);
    expect((await route.POST(post("accept"), ctx(enquiryId))).status).toBe(400);
  });
  it("does the whole flow over HTTP and keeps the token out of the owner's view", async () => {
    state.actor = buyer;
    expect((await route.POST(post("request"), ctx(enquiryId))).status).toBe(201);
    expect((await route.POST(post("issue"), ctx(enquiryId))).status).toBe(403);
    state.actor = owner;
    const issued = await route.POST(post("issue"), ctx(enquiryId));
    expect(issued.status).toBe(201);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await issued.json())).not.toMatch(/token/);
    const ownerView = await (await route.GET(new Request("http://test/x"), ctx(enquiryId))).json();
    expect(JSON.stringify(ownerView)).not.toMatch(/token/);
    state.actor = buyer;
    const buyerView = (await (await route.GET(new Request("http://test/x"), ctx(enquiryId))).json()) as { link?: { token: string } };
    expect(buyerView.link?.token).toBeTruthy();
    state.actor = stranger;
    expect((await route.GET(new Request("http://test/x"), ctx(enquiryId))).status).toBe(404);
  });
});

describe("db/20261024150000_offer_link_request.sql", () => {
  const sql = readFileSync(new URL("../db/20261024150000_offer_link_request.sql", import.meta.url), "utf8");
  it("guards the hourly automated notice with a partial unique index", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX enquiry_message_one_notice_per_hour_idx\s+ON enquiry_message \(enquiry_id, date_trunc\('hour', sent_at AT TIME ZONE 'UTC'\)\)\s+WHERE automated;/);
  });
  it("allows one open request per thread", () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX offer_link_request_one_open_idx ON offer_link_request\(enquiry_id\) WHERE status = 'requested'/);
  });
  it("never updates or deletes enquiry_message in app SQL", () => {
    const code = readFileSync(new URL("../src/server/enquiry-db.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/(UPDATE|DELETE FROM)\s+enquiry_message/i);
    expect(code).toMatch(/INSERT INTO enquiry_message[^`"]*[\s\S]*?ON CONFLICT DO NOTHING RETURNING id/);
  });
});
