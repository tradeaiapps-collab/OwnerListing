import { forbiddenFor } from "./access";
import { canContactSeller, nextVerificationStep } from "./buyer";
import { participantEnquiry, type Enquiry, type EnquiryDeps, type EnquiryMessage } from "./enquiry-service";
import type { Actor, Failure, Result } from "./listing-service";
import { OfferLinkKeyError, openOfferToken, sealOfferToken } from "./offer-link-crypto";
import { createOfferLink, type OfferLinkRecord } from "./offer-intake";
import { OFFER_LINK_ISSUE_RATE, OFFER_LINK_REQUEST_RATE, withinLimit } from "./rate-limit";

export type OfferLinkRequestStatus = "requested" | "issued" | "declined";
export interface OfferLinkRequest { id: string; enquiryId: string; status: OfferLinkRequestStatus; requestedAt: string; decidedAt?: string }

/** State only. The thread messages go through the append-only enquiry repository. */
export interface OfferLinkRequestRepository {
  /** False when the thread already has an open request (db unique index). */
  open(r: { id: string; enquiryId: string; at: string }): Promise<boolean>;
  latest(enquiryId: string): Promise<OfferLinkRequest | undefined>;
  /** Guarded: only an open request can be declined. False means it changed under us. */
  decline(id: string, at: string): Promise<boolean>;
  /** Guarded and atomic: marks the open request issued and stores the link (hash) and the sealed token together, or does neither. Throws OfferLinkKeyError, storing nothing, when the key is unusable. */
  issue(id: string, link: OfferLinkRecord, token: string, at: string): Promise<boolean>;
  /** The delivered link only while it is unused and unexpired. Undefined (never the token) when the server key is unusable or the data fails its integrity check. */
  liveLink(enquiryId: string, now: string): Promise<{ token: string; listingId: string; expiresAt: string } | undefined>;
}

export interface OfferLinkDeps extends EnquiryDeps {
  offerLinks: OfferLinkRequestRepository;
  /** Active buyer account, fully verified, not the listing owner. Re-checked on request, on issue and on every read of the token. */
  eligibleBuyer: (buyerUserId: string, ownerUserId: string) => Promise<boolean>;
}

export const REQUEST_TEXT = "I would like a secure formal offer link for this property, please.";
export const ISSUED_TEXT = "I have approved your request. A secure single-use offer link is ready for you in this conversation. It expires in 24 hours.";
export const DECLINED_TEXT = "I am not able to issue a formal offer link right now.";

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const NOT_FOUND = fail("not_found", "Enquiry not found.");

/** Fails closed: an unreadable counter counts as over the limit. */
async function overLimit(deps: OfferLinkDeps, key: string, windowMs: number, limit: number): Promise<boolean> {
  try {
    return !withinLimit(await deps.countHit(key, windowMs), limit);
  } catch {
    return true;
  }
}

async function say(deps: OfferLinkDeps, e: Enquiry, senderUserId: string, body: string): Promise<EnquiryMessage> {
  const m: EnquiryMessage = { id: deps.newId(), enquiryId: e.id, senderUserId, automated: false, body, sentAt: deps.now() };
  await deps.enquiries.addMessage(m);
  return m;
}

const audit = (deps: OfferLinkDeps, actorId: string, enquiryId: string, eventType: string, payload: Record<string, unknown>) =>
  deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId,
    aggregateType: "enquiry", aggregateId: enquiryId, eventType, correlationId: deps.newId(), payload
  });

/** The buyer of the thread asks the owner for a formal offer link. Nothing is issued here. */
export async function requestOfferLink(deps: OfferLinkDeps, actor: Actor, enquiryId: string): Promise<Result<OfferLinkRequest>> {
  const p = await participantEnquiry(deps, actor, enquiryId);
  if (!p.ok) return p;
  const { enquiry, ownerUserId } = p.value;
  if (actor.userType !== "buyer" || enquiry.buyerUserId !== actor.userId) return fail("forbidden", "Only the buyer in this conversation can request an offer link.");
  const rec = await deps.listings.get(enquiry.listingId);
  if (!rec || rec.listing.status !== "published") return NOT_FOUND;
  // Verification is re-checked now, not trusted from when the thread started.
  const v = await deps.verification(actor.userId);
  if (!canContactSeller(v) || !(await deps.eligibleBuyer(actor.userId, ownerUserId))) {
    return fail("forbidden", nextVerificationStep(v) ? "Finish verifying your account before requesting an offer link." : "You cannot request an offer link on this listing.");
  }
  if (await overLimit(deps, `olr:${actor.userId}`, OFFER_LINK_REQUEST_RATE.windowMs, OFFER_LINK_REQUEST_RATE.perBuyer)) {
    return fail("rate_limited", "You have requested too many offer links. Try again later.");
  }
  const req = { id: deps.newId(), enquiryId, at: deps.now() };
  if (!(await deps.offerLinks.open(req))) return fail("conflict", "You already have a request waiting for the owner.");
  const m = await say(deps, enquiry, actor.userId, REQUEST_TEXT);
  await audit(deps, actor.userId, enquiryId, "offer_link.requested", { requestId: req.id, messageId: m.id });
  return { ok: true, value: { id: req.id, enquiryId, status: "requested", requestedAt: req.at } };
}

async function openRequestForOwner(deps: OfferLinkDeps, actor: Actor, enquiryId: string): Promise<Result<{ enquiry: Enquiry; request: OfferLinkRequest; ownerUserId: string }>> {
  // The owner (offer.approve) or the listing's appointed agent (offer.analyse, plus a valid appointment and licence,
  // checked by participantEnquiry) may answer a request. Buyers and everyone else are denied. Deciding on offers stays with the owner.
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.analyse");
  if (denied) return denied;
  const p = await participantEnquiry(deps, actor, enquiryId, "offer_links.issue");
  if (!p.ok) return p;
  if (p.value.ownerUserId === actor.userId) {
    const notOwnerRole = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.approve");
    if (notOwnerRole) return notOwnerRole;
  } else if (!p.value.asAgent) return NOT_FOUND; // the buyer of the thread, or anyone else
  const rec = await deps.listings.get(p.value.enquiry.listingId);
  if (!rec || rec.listing.status !== "published") return NOT_FOUND;
  const latest = await deps.offerLinks.latest(enquiryId);
  if (!latest || latest.status !== "requested") return fail("conflict", "There is no open request to answer.");
  return { ok: true, value: { enquiry: p.value.enquiry, request: latest, ownerUserId: p.value.ownerUserId } };
}

/** The owner approves the open request and issues the single-use link. Only a person approves; the AI has no part in this. */
export async function issueOfferLinkFromThread(deps: OfferLinkDeps, actor: Actor, enquiryId: string): Promise<Result<{ expiresAt: string }>> {
  const o = await openRequestForOwner(deps, actor, enquiryId);
  if (!o.ok) return o;
  const { enquiry, request, ownerUserId } = o.value;
  // The buyer is re-checked at issue time too (against the listing's owner, who may not be the one acting).
  if (!(await deps.eligibleBuyer(enquiry.buyerUserId, ownerUserId)) || !canContactSeller(await deps.verification(enquiry.buyerUserId))) {
    return fail("invalid", "An offer link could not be created for that buyer.");
  }
  if (await overLimit(deps, `issue:${actor.userId}`, OFFER_LINK_ISSUE_RATE.windowMs, OFFER_LINK_ISSUE_RATE.perOwner)) {
    return fail("rate_limited", "Too many offer links requested. Try again later.");
  }
  const now = deps.now();
  const { token, record } = await createOfferLink(enquiry.listingId, enquiry.buyerUserId, now);
  try {
    if (!(await deps.offerLinks.issue(request.id, record, token, now))) return fail("conflict", "That request was already answered.");
  } catch (e) {
    // No key, no link: nothing was stored or issued.
    if (e instanceof OfferLinkKeyError) return fail("unavailable", "Offer links are temporarily unavailable.");
    throw e;
  }
  const m = await say(deps, enquiry, actor.userId, ISSUED_TEXT);
  await audit(deps, actor.userId, enquiryId, "offer_link.issued", { requestId: request.id, messageId: m.id, expiresAt: record.expiresAt, byAppointedAgent: actor.userId !== ownerUserId });
  return { ok: true, value: { expiresAt: record.expiresAt } };
}

export async function declineOfferLinkFromThread(deps: OfferLinkDeps, actor: Actor, enquiryId: string): Promise<Result<true>> {
  const o = await openRequestForOwner(deps, actor, enquiryId);
  if (!o.ok) return o;
  if (!(await deps.offerLinks.decline(o.value.request.id, deps.now()))) return fail("conflict", "That request was already answered.");
  const m = await say(deps, o.value.enquiry, actor.userId, DECLINED_TEXT);
  await audit(deps, actor.userId, enquiryId, "offer_link.declined", { requestId: o.value.request.id, messageId: m.id, byAppointedAgent: actor.userId !== o.value.ownerUserId });
  return { ok: true, value: true };
}

export interface OfferLinkState {
  /** The viewer's side of the thread. */
  role: "buyer" | "owner";
  request?: { status: OfferLinkRequestStatus; requestedAt: string };
  /** Only ever present for the buyer. The owner never sees the token. */
  link?: { token: string; listingId: string; expiresAt: string };
}

export async function offerLinkState(deps: OfferLinkDeps, actor: Actor, enquiryId: string): Promise<Result<OfferLinkState>> {
  const p = await participantEnquiry(deps, actor, enquiryId);
  if (!p.ok) return p;
  const latest = await deps.offerLinks.latest(enquiryId);
  const isBuyer = actor.userId === p.value.enquiry.buyerUserId;
  const state: OfferLinkState = { role: isBuyer ? "buyer" : "owner", ...(latest ? { request: { status: latest.status, requestedAt: latest.requestedAt } } : {}) };
  if (latest?.status === "issued" && actor.userType === "buyer" && isBuyer) {
    // Re-checked on every read: a buyer who lost verification no longer gets the token.
    const ok = (await deps.eligibleBuyer(actor.userId, p.value.ownerUserId)) && canContactSeller(await deps.verification(actor.userId));
    const link = ok ? await deps.offerLinks.liveLink(enquiryId, deps.now()) : undefined;
    if (link) state.link = link;
  }
  return { ok: true, value: state };
}

export function createInMemoryOfferLinkRepository(key?: string): OfferLinkRequestRepository {
  const rows: OfferLinkRequest[] = [];
  const links = new Map<string, { link: OfferLinkRecord; sealed: string | null }>();
  const byEnquiry = new Map<string, string>();
  return {
    async open(r) {
      if (rows.some(x => x.enquiryId === r.enquiryId && x.status === "requested")) return false;
      rows.push({ id: r.id, enquiryId: r.enquiryId, status: "requested", requestedAt: r.at });
      return true;
    },
    async latest(enquiryId) { return rows.filter(x => x.enquiryId === enquiryId).at(-1); },
    async decline(id, at) {
      const r = rows.find(x => x.id === id && x.status === "requested");
      if (!r) return false;
      r.status = "declined";
      r.decidedAt = at;
      return true;
    },
    async issue(id, link, token, at) {
      const r = rows.find(x => x.id === id && x.status === "requested");
      if (!r) return false;
      const sealed = await sealOfferToken(token, key, id);
      r.status = "issued";
      r.decidedAt = at;
      links.set(link.tokenHash, { link, sealed });
      byEnquiry.set(r.enquiryId, link.tokenHash);
      return true;
    },
    async liveLink(enquiryId, now) {
      const h = byEnquiry.get(enquiryId);
      const x = h ? links.get(h) : undefined;
      if (!x) return undefined;
      if (x.link.usedAt !== undefined || x.link.expiresAt <= now) { x.sealed = null; return undefined; }
      const reqId = rows.find(r => r.enquiryId === enquiryId && r.status === "issued")?.id;
      const token = x.sealed && reqId ? await openOfferToken(x.sealed, key, reqId).catch(() => undefined) : undefined;
      if (token === undefined) return undefined;
      return { token, listingId: x.link.listingId, expiresAt: x.link.expiresAt };
    }
  };
}
