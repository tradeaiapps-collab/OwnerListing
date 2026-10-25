import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../src/domain/access";
import { hashToken, validateFormalOffer, validateOfferLink, type FormalOffer } from "../../../../../src/domain/offer-intake";
import { parseOfferSubmission } from "../../../../../src/domain/offer-submission";
import { clientIp } from "../../../../../src/server/client-ip";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { OFFER_RATE, windowStart, withinLimit } from "../../../../../src/domain/rate-limit";
import { countHitPg, eligibleBuyerPg } from "../../../../../src/server/offer-flow-db";
import { expireCountersPg } from "../../../../../src/server/offer-counter-db";
import { offerLinkPg, offersForOwnerPg, submitOfferPg } from "../../../../../src/server/offers-db";
import { csrfGuard } from "../../../../../src/server/csrf";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";

type Ctx = { params: Promise<{ id: string }> };

const notFound = { ok: false, code: "not_found", message: "Listing not found." } as const;
const badLink = { ok: false, code: "invalid", message: "This offer link is not valid." } as const;

/**
 * A buyer submits a formal offer. The credential is the single-use link token from the chat (stored only as a hash,
 * bound to one buyer and one listing). The buyer id comes from the link row, never from the request body.
 * Nothing here accepts, counters or rejects an offer: the owner decides.
 */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { id } = await params;
  const parsed = parseOfferSubmission(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.status !== "published") return failure(notFound);

  const db = getDb();
  const now = deps.now();
  const tokenHash = await hashToken(parsed.value.token);
  // Rate limit per link and per IP-hash window, before the link lookup. Fails closed: a store error blocks the request.
  const ip = clientIp(req);
  const start = windowStart(now, OFFER_RATE.windowMs);
  try {
    const perLink = await countHitPg(db, await hashToken(`link:${tokenHash}`), start);
    const perIp = await countHitPg(db, await hashToken(`ip:${ip}`), start);
    if (!withinLimit(perLink, OFFER_RATE.perLink) || !withinLimit(perIp, OFFER_RATE.perIp)) {
      return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "Retry-After": "600" } });
    }
  } catch {
    return NextResponse.json({ error: "Offers are unavailable right now. Try again later." }, { status: 503 });
  }

  // The link is a bearer token, so it is only honoured for the buyer it was issued to, signed in as that buyer.
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const link = await offerLinkPg(db, tokenHash);
  if (!link) return failure(badLink);
  if (actor.userId !== link.buyerUserId) return failure(badLink);
  // Re-check at submit time: the buyer may have been suspended or lost verification since the link was issued.
  if (!(await eligibleBuyerPg(db, link.buyerUserId, rec.listing.ownerUserId))) {
    return failure({ ok: false, code: "forbidden", message: "You cannot submit an offer on this listing." });
  }

  const offer: FormalOffer = {
    listingId: id,
    buyerUserId: link.buyerUserId,
    priceCents: parsed.value.priceCents,
    conditions: parsed.value.conditions,
    settlementDays: parsed.value.settlementDays,
    depositCents: parsed.value.depositCents,
    confirmedFinal: parsed.value.confirmedFinal,
    submittedAt: now
  };
  const problems = [...validateOfferLink(link, link.buyerUserId, id, now), ...validateFormalOffer(offer)];
  if (problems.length > 0) return NextResponse.json({ error: problems.join(" ") }, { status: 400 });

  const saved = await submitOfferPg(db, {
    tokenHash: link.tokenHash,
    listingId: id,
    priceCents: offer.priceCents,
    conditions: offer.conditions,
    settlementDays: offer.settlementDays,
    depositCents: offer.depositCents,
    now
  });
  if (!saved) return failure({ ok: false, code: "conflict", message: "This offer link has already been used or has expired." });

  await deps.appendAudit({
    id: deps.newId(),
    occurredAt: now,
    actorType: "user",
    actorId: link.buyerUserId,
    aggregateType: "formal_offer",
    aggregateId: saved.id,
    eventType: "offer.submitted",
    correlationId: deps.newId(),
    payload: { listingId: id }
  });
  return NextResponse.json({ offer: saved }, { status: 201 });
}

/** The listing's owner or its appointed (licensed) agent reviews offers. Everyone else gets 404 so the listing's existence is not revealed. */
export async function GET(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.analyse");
  if (denied) return failure(denied);
  const { id } = await params;
  const handler = await requireListingHandler(req, id);
  if (handler instanceof NextResponse) return handler;
  const db = getDb();
  await expireCountersPg(db, getDeps().now(), { listingId: id });
  return NextResponse.json({ offers: await offersForOwnerPg(db, id, handler.rec.listing.ownerUserId) });
}
