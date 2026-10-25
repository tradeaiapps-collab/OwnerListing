import { NextResponse } from "next/server";
import { BUYER_TURN, counterExpiry, parseCounterInput, sameTerms } from "../../../../../src/domain/offer-counter";
import { requireBuyerOffer } from "../../../../../src/server/buyer-offer";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure } from "../../../../../src/server/http";
import { buyerCounterPg, countersForOfferPg } from "../../../../../src/server/offer-counter-db";
import { eligibleBuyerPg } from "../../../../../src/server/offer-flow-db";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";

type Ctx = { params: Promise<{ offerId: string }> };

const conflict = { ok: false, code: "conflict", message: "You cannot counter now. The owner may not have countered, the counter may have expired, or the 10-round limit was reached." } as const;

/** The buyer answers the owner's counter (or request for a counter) with new terms. Only the buyer of this offer. */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { offerId } = await params;
  const parsed = parseCounterInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const mine = await requireBuyerOffer(req, offerId);
  if (mine instanceof NextResponse) return mine;
  const { actor, offer } = mine;
  const deps = getDeps();
  const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  if (offer.status !== BUYER_TURN) return failure(conflict);

  const db = getDb();
  const rec = await deps.repo.get(offer.listingId);
  // Re-check: the buyer may have been suspended or lost verification since the offer.
  if (!rec || !(await eligibleBuyerPg(db, actor.userId, rec.listing.ownerUserId))) {
    return failure({ ok: false, code: "forbidden", message: "You cannot make a counter-offer on this listing." });
  }
  const ownerCounter = (await countersForOfferPg(db, offerId)).find(c => c.status === "open" && c.fromParty === "owner");
  if (ownerCounter && sameTerms(parsed.value, ownerCounter)) {
    return failure({ ok: false, code: "invalid", message: "These are the owner's terms. Use \"Agree to these terms\" instead." });
  }
  const now = deps.now();
  const { expiresInDays, ...terms } = parsed.value;
  const saved = await buyerCounterPg(db, { ...terms, offerId, userId: actor.userId, now, expiresAt: counterExpiry(now, expiresInDays) });
  if (!saved) return failure(conflict);

  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "formal_offer", aggregateId: offerId, eventType: "offer.buyer_countered",
    correlationId: deps.newId(), payload: { listingId: offer.listingId, counterId: saved.id, round: saved.round }
  });
  return NextResponse.json({ offer: { id: offerId, status: "buyer_countered" }, counter: { id: saved.id, round: saved.round } }, { status: 201 });
}
