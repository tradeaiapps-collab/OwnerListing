import type { AuditEvent } from "./audit";
import { canContactSeller } from "./buyer";
import { fail, type Actor, type ListingRepository, type Result } from "./listing-service";
import {
  createOfferLink, hashToken, validateFormalOffer, validateOfferLink,
  type FormalOffer, type OfferLinkRecord
} from "./offer-intake";
import type { BuyerVerification } from "./buyer";

export type OfferStatus = "submitted" | "under_review" | "countered" | "accepted" | "rejected" | "withdrawn";

export interface OfferRecord {
  id: string;
  listingId: string;
  buyerUserId: string;
  priceCents: number;
  conditions: string[];
  settlementDays: number;
  depositCents: number;
  status: OfferStatus;
  submittedAt: string;
}

export interface OfferRepository {
  insertLink(link: OfferLinkRecord, createdAt: string): Promise<void>;
  findLink(tokenHash: string): Promise<OfferLinkRecord | undefined>;
  /** Marks the link used and stores the offer in one atomic step. False if the link was already used. */
  submit(offer: OfferRecord, tokenHash: string): Promise<boolean>;
  get(id: string): Promise<OfferRecord | undefined>;
  listByListings(listingIds: readonly string[]): Promise<OfferRecord[]>;
  listByBuyer(buyerUserId: string): Promise<OfferRecord[]>;
  /** Compare-and-set: only moves the offer if it is still in `from`. */
  setStatus(id: string, from: OfferStatus, to: OfferStatus): Promise<boolean>;
}

export interface OfferDeps {
  offers: OfferRepository;
  listings: ListingRepository;
  verification: (userId: string) => Promise<BuyerVerification>;
  appendAudit: (e: AuditEvent) => Promise<void>;
  now: () => string;
  newId: () => string;
}

export interface OfferInput {
  token: string;
  priceCents: number;
  conditions: string[];
  settlementDays: number;
  depositCents: number;
  confirmedFinal: boolean;
}

export function parseOfferInput(body: unknown): Result<OfferInput> {
  if (typeof body !== "object" || body === null) return fail("invalid", "Invalid input.");
  const b = body as Record<string, unknown>;
  const { token, priceCents, settlementDays, depositCents, confirmedFinal } = b;
  const conditions = b["conditions"] ?? [];
  if (typeof token !== "string" || !token || token.length > 200) return fail("invalid", "The offer link is missing.");
  if (typeof priceCents !== "number" || typeof settlementDays !== "number" || typeof depositCents !== "number") {
    return fail("invalid", "Price, deposit and settlement days must be numbers.");
  }
  if (!Array.isArray(conditions) || conditions.some(c => typeof c !== "string")) return fail("invalid", "Conditions must be a list of text.");
  return {
    ok: true,
    value: { token, priceCents, settlementDays, depositCents, conditions: conditions as string[], confirmedFinal: confirmedFinal === true }
  };
}

/** Creates a single-use link for a buyer and returns the full URL. Only the hash is stored. */
export async function issueOfferLink(deps: OfferDeps, appUrl: string, listingId: string, buyerUserId: string): Promise<string> {
  const now = deps.now();
  const { token, record } = await createOfferLink(listingId, buyerUserId, now);
  await deps.offers.insertLink(record, now);
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "system", actorId: "system:offer-assistant",
    aggregateType: "listing", aggregateId: listingId, eventType: "offer_link.created",
    correlationId: deps.newId(), payload: { buyerUserId }
  });
  return `${appUrl}/offers/new?token=${token}`;
}

async function usableLink(deps: OfferDeps, actor: Actor, token: string): Promise<Result<OfferLinkRecord>> {
  const link = await deps.offers.findLink(await hashToken(token));
  if (!link) return fail("not_found", "This offer link is not valid.");
  const problems = validateOfferLink(link, actor.userId, link.listingId, deps.now());
  if (problems.length > 0) return fail("conflict", problems.join(" "));
  return { ok: true, value: link };
}

/** Lets the form show which property a link is for before the buyer fills it in. */
export async function checkOfferLink(deps: OfferDeps, actor: Actor, token: string): Promise<Result<{ listingId: string; listingTitle: string }>> {
  const link = await usableLink(deps, actor, token);
  if (!link.ok) return link;
  const rec = await deps.listings.get(link.value.listingId);
  if (!rec || rec.listing.status !== "published") return fail("not_found", "This listing is no longer available.");
  return { ok: true, value: { listingId: rec.listing.id, listingTitle: rec.listing.title } };
}

export async function submitOffer(deps: OfferDeps, actor: Actor, input: OfferInput): Promise<Result<OfferRecord>> {
  const link = await usableLink(deps, actor, input.token);
  if (!link.ok) return link;
  const rec = await deps.listings.get(link.value.listingId);
  if (!rec || rec.listing.status !== "published") return fail("not_found", "This listing is no longer available.");
  if (rec.listing.ownerUserId === actor.userId) return fail("forbidden", "You cannot make an offer on your own listing.");
  if (!canContactSeller(await deps.verification(actor.userId))) return fail("forbidden", "Complete verification before making an offer.");

  const now = deps.now();
  const formal: FormalOffer = {
    listingId: rec.listing.id, buyerUserId: actor.userId, priceCents: input.priceCents, conditions: input.conditions,
    settlementDays: input.settlementDays, depositCents: input.depositCents, confirmedFinal: input.confirmedFinal, submittedAt: now
  };
  const problems = validateFormalOffer(formal);
  if (problems.length > 0) return fail("invalid", problems.join(" "));

  const offer: OfferRecord = {
    id: deps.newId(), listingId: formal.listingId, buyerUserId: actor.userId, priceCents: formal.priceCents,
    conditions: input.conditions.map(c => c.trim()), settlementDays: formal.settlementDays, depositCents: formal.depositCents,
    status: "submitted", submittedAt: now
  };
  if (!(await deps.offers.submit(offer, link.value.tokenHash))) return fail("conflict", "This link has already been used.");
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "offer", aggregateId: offer.id, eventType: "offer.submitted",
    correlationId: deps.newId(), payload: { listingId: offer.listingId }
  });
  return { ok: true, value: offer };
}

const OWNER_MOVES: Record<string, readonly OfferStatus[]> = {
  submitted: ["under_review", "rejected", "accepted"],
  under_review: ["rejected", "accepted"]
};
const BUYER_MOVES: Record<string, readonly OfferStatus[]> = {
  submitted: ["withdrawn"],
  under_review: ["withdrawn"]
};

/**
 * The owner reviews, rejects or accepts; the buyer can withdraw. Accepting is always a human action and is not a contract.
 * Anyone else gets not_found.
 */
export async function changeStatus(deps: OfferDeps, actor: Actor, offerId: string, to: OfferStatus): Promise<Result<OfferRecord>> {
  const offer = await deps.offers.get(offerId);
  if (!offer) return fail("not_found", "Offer not found.");
  const listing = await deps.listings.get(offer.listingId);
  const isOwner = listing?.listing.ownerUserId === actor.userId;
  const isBuyer = offer.buyerUserId === actor.userId;
  if (!isOwner && !isBuyer) return fail("not_found", "Offer not found.");

  const allowed = isOwner ? OWNER_MOVES[offer.status] : BUYER_MOVES[offer.status];
  if (!allowed?.includes(to)) return fail("conflict", `This offer cannot move from ${offer.status} to ${to}.`);
  if (!(await deps.offers.setStatus(offer.id, offer.status, to))) return fail("conflict", "The offer changed. Refresh and try again.");

  const now = deps.now();
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "offer", aggregateId: offer.id, eventType: `offer.${to}`,
    correlationId: deps.newId(), payload: { from: offer.status, to }
  });
  return { ok: true, value: { ...offer, status: to } };
}

export interface OfferListItem { offer: OfferRecord; listingTitle: string; role: "buyer" | "owner" }

/** Offers the user made and offers on their own listings, newest first. Prices are visible only to those two sides. */
export async function myOffers(deps: OfferDeps, actor: Actor): Promise<OfferListItem[]> {
  const mine = await deps.listings.listByOwner(actor.userId);
  const titles = new Map(mine.map(r => [r.listing.id, r.listing.title] as const));
  const asOwner = await deps.offers.listByListings([...titles.keys()]);
  const asBuyer = await deps.offers.listByBuyer(actor.userId);
  const items: OfferListItem[] = asOwner.map(o => ({ offer: o, listingTitle: titles.get(o.listingId) ?? "", role: "owner" as const }));
  for (const o of asBuyer) {
    if (items.some(i => i.offer.id === o.id)) continue;
    const rec = await deps.listings.get(o.listingId);
    items.push({ offer: o, listingTitle: rec?.listing.title ?? "", role: "buyer" });
  }
  return items.sort((a, b) => (a.offer.submittedAt < b.offer.submittedAt ? 1 : a.offer.submittedAt > b.offer.submittedAt ? -1 : 0));
}

export function createInMemoryOfferRepository(): OfferRepository {
  const links = new Map<string, OfferLinkRecord>();
  const offers = new Map<string, OfferRecord>();
  return {
    async insertLink(l) { links.set(l.tokenHash, l); },
    async findLink(h) { return links.get(h); },
    async submit(o, h) {
      const l = links.get(h);
      if (!l || l.usedAt !== undefined) return false;
      links.set(h, { ...l, usedAt: o.submittedAt });
      offers.set(o.id, o);
      return true;
    },
    async get(id) { return offers.get(id); },
    async listByListings(ids) { return [...offers.values()].filter(o => ids.includes(o.listingId)); },
    async listByBuyer(id) { return [...offers.values()].filter(o => o.buyerUserId === id); },
    async setStatus(id, from, to) {
      const o = offers.get(id);
      if (!o || o.status !== from) return false;
      offers.set(id, { ...o, status: to });
      return true;
    }
  };
}
