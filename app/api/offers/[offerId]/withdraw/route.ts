import { NextResponse } from "next/server";
import { WITHDRAWABLE } from "../../../../../src/domain/offer-counter";
import { requireBuyerOffer } from "../../../../../src/server/buyer-offer";
import { getDb, getDeps } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure } from "../../../../../src/server/http";
import { buyerWithdrawPg } from "../../../../../src/server/offer-counter-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ offerId: string }> };

/** The buyer withdraws their offer before it is accepted. Always allowed for an open offer, even if their verification lapsed. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const { offerId } = await params;
  const mine = await requireBuyerOffer(req, offerId);
  if (mine instanceof NextResponse) return mine;
  const { actor, offer } = mine;
  const deps = getDeps();
  const now = deps.now();
  if (!(await buyerWithdrawPg(getDb(), offerId, actor.userId, WITHDRAWABLE, now))) {
    return failure({ ok: false, code: "conflict", message: "This offer can no longer be withdrawn." });
  }
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "formal_offer", aggregateId: offerId, eventType: "offer.withdrawn",
    correlationId: deps.newId(), payload: { listingId: offer.listingId, from: offer.status }
  });
  return NextResponse.json({ offer: { id: offerId, status: "withdrawn" } });
}

export const POST = withApi(handlePost);
