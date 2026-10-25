import { NextResponse } from "next/server";
import { BUYER_TURN, parseAgree } from "../../../../../src/domain/offer-counter";
import { isUuid } from "../../../../../src/domain/offer-decision";
import { requireBuyerOffer } from "../../../../../src/server/buyer-offer";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure } from "../../../../../src/server/http";
import { buyerAgreePg } from "../../../../../src/server/offer-counter-db";
import { eligibleBuyerPg } from "../../../../../src/server/offer-flow-db";
import { requireCurrentTerms } from "../../../../../src/server/terms-guard";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ offerId: string }> };

const conflict = { ok: false, code: "conflict", message: "That counter-offer is no longer open." } as const;

/**
 * The buyer agrees to the owner's open counter. This does NOT accept the offer: only the owner accepts, so the offer goes
 * back to the owner with the agreed terms. Only the buyer of this offer.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { offerId } = await params;
  const counterId = parseAgree(await req.json().catch(() => null));
  if (!isUuid(counterId)) return failure({ ok: false, code: "invalid", message: "Choose the counter-offer you agree to." });
  const mine = await requireBuyerOffer(req, offerId);
  if (mine instanceof NextResponse) return mine;
  const { actor, offer } = mine;
  const deps = getDeps();
  const noTerms = await requireCurrentTerms(deps.termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  if (offer.status !== BUYER_TURN) return failure(conflict);
  const db = getDb();
  const rec = await deps.repo.get(offer.listingId);
  if (!rec || !(await eligibleBuyerPg(db, actor.userId, rec.listing.ownerUserId))) {
    return failure({ ok: false, code: "forbidden", message: "You cannot respond to offers on this listing." });
  }
  const now = deps.now();
  if (!(await buyerAgreePg(db, offerId, actor.userId, counterId, now))) return failure(conflict);

  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "formal_offer", aggregateId: offerId, eventType: "offer.buyer_agreed",
    correlationId: deps.newId(), payload: { listingId: offer.listingId, counterId }
  });
  return NextResponse.json({ offer: { id: offerId, status: "buyer_countered" } });
}

export const POST = withApi(handlePost);
