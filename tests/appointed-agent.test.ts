import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAppointment } from "../src/domain/access";
import { isAppointedAgent, type AppointedAgentDeps } from "../src/domain/appointed-agent";
import type { AuditEvent } from "../src/domain/audit";
import type { BuyerVerification } from "../src/domain/buyer";
import { createInMemoryDraftRepository } from "../src/domain/enquiry-drafts";
import { createInMemoryEnquiryRepository, getThread, reply, sendDraft, startEnquiry } from "../src/domain/enquiry-service";
import type { AgentLicence } from "../src/domain/licence";
import type { PropertyListing } from "../src/domain/listing";
import { createInMemoryListingRepository, type Actor, type ListingServiceDeps } from "../src/domain/listing-service";
import {
  createInMemoryOfferLinkRepository, declineOfferLinkFromThread, issueOfferLinkFromThread, offerLinkState, requestOfferLink,
  type OfferLinkDeps
} from "../src/domain/offer-link-request";
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

import { POST as analysisPost, GET as analysisGet } from "../app/api/listings/[id]/offer-analysis/route";
import { POST as issuePost } from "../app/api/listings/[id]/offer-links/route";
import { POST as decisionPost } from "../app/api/listings/[id]/offers/[offerId]/decision/route";
import { GET as offersGet } from "../app/api/listings/[id]/offers/route";
process.env["APP_URL"] = "http://test";

const L = "11111111-1111-4111-8111-111111111111";
const L2 = "11111111-1111-4111-8111-222222222222";
const OFFER = "77777777-7777-4777-8777-777777777777";
const owner: Actor = { userId: "22222222-2222-4222-8222-222222222222", userType: "owner" };
const agent: Actor = { userId: "55555555-5555-4555-8555-555555555555", userType: "agent" };
const otherAgent: Actor = { userId: "66666666-6666-4666-8666-666666666666", userType: "agent" };
const buyer: Actor = { userId: "33333333-3333-4333-8333-333333333333", userType: "buyer" };
const full: BuyerVerification = { emailVerified: true, phoneVerified: true, idVerified: true };
const NOW = "2026-10-24T00:00:00.000Z";

const listing = (id: string, over: Partial<PropertyListing> = {}): PropertyListing => ({
  id, ownerUserId: owner.userId, ownerUserType: "owner", jurisdiction: "QLD", status: "published", title: "Home", propertyType: "house",
  useClass: "residential", transactionType: "sale", address: "1 Test St", disclosures: [], priceCents: 85_000_000,
  createdAt: NOW, updatedAt: NOW, ...over
});
const appt = (listingId: string, agentUserId: string, over: Partial<AgentAppointment> = {}): AgentAppointment =>
  ({ listingId, agentUserId, scope: "enquiries_and_offers", revoked: false, ...over });
const licence = (userId: string, over: Partial<AgentLicence> = {}): AgentLicence =>
  ({ userId, jurisdiction: "QLD", status: "verified", expiresAt: "2027-01-01", ...over });

let n: number;
let audit: AuditEvent[];
let appointments: AgentAppointment[];
let licences: AgentLicence[];
let eligibleCalls: [string, string][];
let deps: OfferLinkDeps;
let enquiryId: string;
let dbCalls: { text: string; params: unknown[] }[];

const lookups = (): AppointedAgentDeps => ({
  appointmentFor: async (l, a) => appointments.find(x => x.listingId === l && x.agentUserId === a),
  licences: async () => licences,
  now: () => NOW
});

beforeEach(async () => {
  n = 0;
  audit = [];
  eligibleCalls = [];
  dbCalls = [];
  appointments = [appt(L, agent.userId)];
  licences = [licence(agent.userId)];
  const listings = createInMemoryListingRepository();
  await listings.insert({ listing: listing(L), listingFeePaid: true, termsAccepted: true });
  await listings.insert({ listing: listing(L2), listingFeePaid: true, termsAccepted: true });
  const enquiries = createInMemoryEnquiryRepository();
  deps = {
    enquiries, listings, drafts: createInMemoryDraftRepository(() => owner.userId),
    verification: async () => full,
    countHit: async () => 1, offerRequestUrl: id => `http://test/enquiries/${id}`,
    appendAudit: async e => { audit.push(e); },
    newId: () => `99999999-9999-4999-8999-${String(++n).padStart(12, "0")}`,
    offerLinks: createInMemoryOfferLinkRepository(Buffer.alloc(32, 7).toString("base64")),
    eligibleBuyer: async (b, o) => { eligibleCalls.push([b, o]); return true; },
    termsCurrentFor: async () => true,
    ...lookups()
  };
  const s = await startEnquiry(deps, buyer, L, "Is it available?");
  if (!s.ok) throw new Error(s.message);
  enquiryId = s.value.enquiry.id;

  state.actor = null;
  state.deps = {
    repo: listings, appendAudit: async e => { audit.push(e); }, newId: () => `id-${++n}`,
    requiredDisclosures: () => [], termsCurrentFor: async () => true, ...lookups()
  };
  state.db = {
    async query(text, params) {
      dbCalls.push({ text, params: params ?? [] });
      if (text.includes("offer_submit_attempt")) return { rows: [{ hits: 1 }] };
      if (text.includes("FROM app_user u JOIN buyer_verification")) return { rows: [{ id: buyer.userId }] };
      if (text.includes("FROM formal_offer o JOIN property_listing")) {
        return { rows: [{ id: OFFER, price_cents: 80_000_000, conditions: [], settlement_days: 30, deposit_cents: 8_000_000, status: "submitted", submitted_at: NOW }] };
      }
      return { rows: [] };
    }
  };
});

describe("isAppointedAgent", () => {
  const l = listing(L);
  it("is true for an agent with an active appointment and a current licence, with either scope", async () => {
    expect(await isAppointedAgent(lookups(), agent, l)).toBe(true);
    appointments = [appt(L, agent.userId, { scope: "full" })];
    expect(await isAppointedAgent(lookups(), agent, l)).toBe(true);
  });
  it("is false with no appointment, a revoked one, one for another listing or another agent", async () => {
    appointments = [];
    expect(await isAppointedAgent(lookups(), agent, l)).toBe(false);
    appointments = [appt(L, agent.userId, { revoked: true })];
    expect(await isAppointedAgent(lookups(), agent, l)).toBe(false);
    appointments = [appt(L2, agent.userId)];
    expect(await isAppointedAgent(lookups(), agent, l)).toBe(false);
    appointments = [appt(L, agent.userId)];
    expect(await isAppointedAgent(lookups(), otherAgent, l)).toBe(false);
  });
  it("is false when the licence is missing, pending, expired (state-local date), or for another state", async () => {
    for (const lic of [[], [licence(agent.userId, { status: "pending" })], [licence(agent.userId, { expiresAt: "2026-10-23" })], [licence(agent.userId, { jurisdiction: "NSW" })]]) {
      licences = lic;
      expect(await isAppointedAgent(lookups(), agent, l)).toBe(false);
    }
    // QLD midnight on 24 Oct is 14:00Z on 23 Oct... so 13:59Z on the 24th is still the 24th locally, and 14:00Z is the 25th.
    licences = [licence(agent.userId, { expiresAt: "2026-10-24" })];
    expect(await isAppointedAgent({ ...lookups(), now: () => "2026-10-24T13:59:00.000Z" }, agent, l)).toBe(true);
    expect(await isAppointedAgent({ ...lookups(), now: () => "2026-10-24T14:00:00.000Z" }, agent, l)).toBe(false);
  });
  it("is false for non-agent roles, and for the owner (who needs no appointment)", async () => {
    appointments = [appt(L, owner.userId), appt(L, buyer.userId)];
    licences = [licence(owner.userId), licence(buyer.userId)];
    expect(await isAppointedAgent(lookups(), owner, l)).toBe(false);
    expect(await isAppointedAgent(lookups(), buyer, l)).toBe(false);
  });
  it("fails closed when a lookup throws, a lookup is not wired, or the state has no time zone", async () => {
    expect(await isAppointedAgent({ ...lookups(), appointmentFor: async () => { throw new Error("down"); } }, agent, l)).toBe(false);
    expect(await isAppointedAgent({ ...lookups(), licences: async () => { throw new Error("down"); } }, agent, l)).toBe(false);
    expect(await isAppointedAgent({ now: () => NOW, licences: async () => licences }, agent, l)).toBe(false);
    expect(await isAppointedAgent({ now: () => NOW, appointmentFor: lookups().appointmentFor! }, agent, l)).toBe(false);
    expect(await isAppointedAgent(lookups(), agent, { ...l, jurisdiction: "XX" as never })).toBe(false);
  });
});

describe("enquiry threads for an appointed agent", () => {
  it("lets the appointed agent read and reply, and the reply is the agent's own message", async () => {
    expect(await getThread(deps, agent, enquiryId)).toMatchObject({ ok: true });
    const r = await reply(deps, agent, enquiryId, "Yes, inspection Saturday.");
    expect(r).toMatchObject({ ok: true, value: { senderUserId: agent.userId, automated: false } });
    expect(audit.some(e => e.eventType === "enquiry.message_sent" && e.actorId === agent.userId)).toBe(true);
  });
  it("answers 404 (not_found) to an agent whose appointment is revoked or missing, unlicensed, or on another listing", async () => {
    const attempts: (() => void)[] = [
      () => { appointments = [appt(L, agent.userId, { revoked: true })]; },
      () => { appointments = []; },
      () => { appointments = [appt(L2, agent.userId)]; },
      () => { appointments = [appt(L, agent.userId)]; licences = []; },
      () => { licences = [licence(agent.userId, { expiresAt: "2026-10-01" })]; }
    ];
    for (const setup of attempts) {
      appointments = [appt(L, agent.userId)];
      licences = [licence(agent.userId)];
      setup();
      expect(await getThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
      expect(await reply(deps, agent, enquiryId, "hello")).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(await getThread(deps, otherAgent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
  });
  it("keeps auto-reply drafts owner-only: an appointed agent cannot send one", async () => {
    expect(await sendDraft(deps, agent, "no-such-draft")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("offer links in a thread for an appointed agent", () => {
  it("lets the appointed agent issue the link; the buyer is checked against the OWNER, and the audit records the agent", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await issueOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: true });
    expect(eligibleCalls.at(-1)).toEqual([buyer.userId, owner.userId]);
    const issued = audit.find(e => e.eventType === "offer_link.issued")!;
    expect(issued.actorId).toBe(agent.userId);
    expect(issued.payload).toMatchObject({ byAppointedAgent: true });
    const b = await offerLinkState(deps, buyer, enquiryId);
    expect(b).toMatchObject({ ok: true, value: { role: "buyer", request: { status: "issued" } } });
    expect(b.ok && b.value.link?.listingId).toBe(L);
    const a = await offerLinkState(deps, agent, enquiryId);
    expect(a.ok && a.value.link).toBeUndefined(); // the token goes to the buyer only
  });
  it("lets the appointed agent decline", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await declineOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: true });
    expect(audit.find(e => e.eventType === "offer_link.declined")?.payload).toMatchObject({ byAppointedAgent: true });
  });
  it("denies a revoked, unlicensed, unappointed or other-listing agent with 404, and issues nothing", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await issueOfferLinkFromThread(deps, otherAgent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    appointments = [appt(L, agent.userId, { revoked: true })];
    expect(await issueOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    appointments = [appt(L2, agent.userId)];
    expect(await declineOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    appointments = [appt(L, agent.userId)];
    licences = [licence(agent.userId, { status: "revoked" })];
    expect(await issueOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    expect(audit.some(e => e.eventType === "offer_link.issued")).toBe(false);
    // The request is still open for the owner.
    licences = [licence(agent.userId)];
    expect(await issueOfferLinkFromThread(deps, owner, enquiryId)).toMatchObject({ ok: true });
  });
  it("still denies the buyer (403) and the agent cannot request a link as a buyer", async () => {
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await issueOfferLinkFromThread(deps, buyer, enquiryId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await requestOfferLink(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

const jsonReq = (url: string, body?: unknown) =>
  new Request(`http://test${url}`, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("listing routes for an appointed agent", () => {
  it("GET offers: the appointed agent sees the offers (queried by the listing's real owner); others get 404", async () => {
    state.actor = agent;
    const r = await offersGet(new Request(`http://test/api/listings/${L}/offers`), ctx(L));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { offers: unknown[] }).offers).toHaveLength(1);
    const q = dbCalls.find(c => c.text.includes("FROM formal_offer o JOIN property_listing"))!;
    expect(q.params).toEqual([L, owner.userId]);

    for (const setup of [
      () => { state.actor = otherAgent; },
      () => { state.actor = agent; appointments = [appt(L, agent.userId, { revoked: true })]; },
      () => { appointments = [appt(L2, agent.userId)]; },
      () => { appointments = [appt(L, agent.userId)]; licences = []; }
    ]) {
      setup();
      dbCalls = [];
      expect((await offersGet(new Request(`http://test/api/listings/${L}/offers`), ctx(L))).status).toBe(404);
      expect(dbCalls).toEqual([]);
    }
  });
  it("GET and POST offer-analysis work for the appointed agent and 404 for an unappointed one", async () => {
    state.actor = agent;
    expect((await analysisGet(new Request(`http://test/api/listings/${L}/offer-analysis`), ctx(L))).status).toBe(200);
    state.actor = otherAgent;
    expect((await analysisGet(new Request(`http://test/api/listings/${L}/offer-analysis`), ctx(L))).status).toBe(404);
    expect((await analysisPost(jsonReq(`/api/listings/${L}/offer-analysis`), ctx(L))).status).toBe(404);
  });
  it("POST offer-links: the appointed agent issues a link for an eligible buyer (checked against the owner); others get 404", async () => {
    state.actor = agent;
    const r = await issuePost(jsonReq(`/api/listings/${L}/offer-links`, { buyerUserId: buyer.userId }), ctx(L));
    expect(r.status).toBe(201);
    const eligibility = dbCalls.find(c => c.text.includes("FROM app_user u JOIN buyer_verification"))!;
    expect(eligibility.params).toEqual([buyer.userId, owner.userId]);
    expect(audit.find(e => e.eventType === "offer_link.issued")?.payload).toMatchObject({ byAppointedAgent: true });

    audit = [];
    for (const who of [otherAgent, agent]) {
      state.actor = who;
      if (who === agent) appointments = [appt(L, agent.userId, { revoked: true })];
      const denied = await issuePost(jsonReq(`/api/listings/${L}/offer-links`, { buyerUserId: buyer.userId }), ctx(L));
      expect(denied.status).toBe(404);
    }
    expect(audit.some(e => e.eventType === "offer_link.issued")).toBe(false);
  });
  it("the owner still can, and a buyer is refused", async () => {
    state.actor = owner;
    expect((await issuePost(jsonReq(`/api/listings/${L}/offer-links`, { buyerUserId: buyer.userId }), ctx(L))).status).toBe(201);
    state.actor = buyer;
    expect((await issuePost(jsonReq(`/api/listings/${L}/offer-links`, { buyerUserId: buyer.userId }), ctx(L))).status).toBe(403);
  });
  it("only the owner decides on offers: an appointed agent gets 403 and nothing is read or changed", async () => {
    state.actor = agent;
    const r = await decisionPost(jsonReq(`/api/listings/${L}/offers/${OFFER}/decision`, { decision: "accept" }), { params: Promise.resolve({ id: L, offerId: OFFER }) });
    expect(r.status).toBe(403);
    expect(dbCalls.some(c => /formal_offer/.test(c.text))).toBe(false);
  });
});

describe("agent permissions narrowed by the owner", () => {
  it("an agent without enquiries.handle cannot read or reply to threads", async () => {
    appointments = [appt(L, agent.userId, { permissions: ["offers.view"] })];
    expect(await getThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await reply(deps, agent, enquiryId, "hello")).toMatchObject({ ok: false, code: "not_found" });
  });
  it("an agent with enquiries but without offer_links.issue can read the thread but not issue or decline a link", async () => {
    appointments = [appt(L, agent.userId, { permissions: ["enquiries.handle"] })];
    await requestOfferLink(deps, buyer, enquiryId);
    expect(await getThread(deps, agent, enquiryId)).toMatchObject({ ok: true });
    expect(await issueOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await declineOfferLinkFromThread(deps, agent, enquiryId)).toMatchObject({ ok: false, code: "not_found" });
    expect(audit.some(e => e.eventType === "offer_link.issued")).toBe(false);
  });
  it("GET offers and offer-analysis need offers.view; POST offer-links needs offer_links.issue", async () => {
    state.actor = agent;
    appointments = [appt(L, agent.userId, { permissions: ["enquiries.handle", "offer_links.issue"] })];
    dbCalls = [];
    expect((await offersGet(new Request(`http://test/api/listings/${L}/offers`), ctx(L))).status).toBe(404);
    expect((await analysisGet(new Request(`http://test/api/listings/${L}/offer-analysis`), ctx(L))).status).toBe(404);
    expect(dbCalls).toEqual([]);
    appointments = [appt(L, agent.userId, { permissions: ["offers.view"] })];
    expect((await offersGet(new Request(`http://test/api/listings/${L}/offers`), ctx(L))).status).toBe(200);
    expect((await issuePost(jsonReq(`/api/listings/${L}/offer-links`, { buyerUserId: buyer.userId }), ctx(L))).status).toBe(404);
  });
  it("a permission outside the scope is ignored: publish is never granted by an enquiries_and_offers appointment", async () => {
    const l = listing(L);
    appointments = [appt(L, agent.userId, { permissions: ["listing.publish"] })];
    expect(await isAppointedAgent(lookups(), agent, l, "listing.publish")).toBe(false);
    expect(await isAppointedAgent(lookups(), agent, l, "enquiries.handle")).toBe(false);
    appointments = [appt(L, agent.userId, { scope: "full", permissions: ["listing.publish"] })];
    expect(await isAppointedAgent(lookups(), agent, l, "listing.publish")).toBe(true);
    expect(await isAppointedAgent(lookups(), agent, l, "offers.view")).toBe(false);
  });
});
