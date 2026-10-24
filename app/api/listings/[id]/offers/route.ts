import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../src/domain/access";
import { hashToken, validateFormalOffer, validateOfferLink, type FormalOffer } from "../../../../../src/domain/offer-intake";
import { parseOfferSubmission } from "../../../../../src/domain/offer-submission";
import { getActor, getDb, getDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { offerLinkPg, offersForOwnerPg, submitOfferPg } from "../../../../../src/server/offers-db";

type Ctx = { params: Promise<{ id: string }> };

const notFound = { ok: false, code: "not_found", message: "Listing not found." } as const;
const badLink = { ok: false, code: "invalid", message: "This offer link is not valid." } as const;

/**
 * A buyer submits a formal offer. The credential is the single-use link token from the chat (stored only as a hash,
 * bound to one buyer and one listing). The buyer id comes from the link row, never from the request body.
 * Nothing here accepts, counters or rejects an offer: the owner decides.
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = parseOfferSubmission(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.status !== "published") return failure(notFound);

  const db = getDb();
  const link = await offerLinkPg(db, await hashToken(parsed.value.token));
  if (!link) return failure(badLink);

  const now = deps.now();
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

/** The listing's owner reviews offers. Other users (and agents) get 404 so the listing's existence is not revealed. */
export async function GET(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.analyse");
  if (denied) return failure(denied);
  const { id } = await params;
  const rec = await getDeps().repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return failure(notFound);
  return NextResponse.json({ offers: await offersForOwnerPg(getDb(), id, actor.userId) });
}
