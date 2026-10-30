import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../../../src/domain/access";
import { isUuid } from "../../../../../../../src/domain/offer-decision";
import { counterExpiry, OWNER_COUNTER_FROM, parseCounterInput, sameTerms } from "../../../../../../../src/domain/offer-counter";
import { getActor, getDb, getDeps } from "../../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { expireCountersPg, ownerCounterPg } from "../../../../../../../src/server/offer-counter-db";
import { offersForOwnerPg } from "../../../../../../../src/server/offers-db";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { notifyOfferOutcome } from "../../../../../../../src/server/notify";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;
const conflict = { ok: false, code: "conflict", message: "You cannot counter this offer now. It may be waiting for the buyer, closed, or at the 10-round limit." } as const;

/**
 * The owner counters the buyer's terms. Owner only (an appointed agent cannot counter, and the AI has no route here).
 * Records proposed terms only: nothing is accepted, no money moves.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.approve");
  if (denied) return failure(denied);
  const { id, offerId } = await params;
  const parsed = parseCounterInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  if (!isUuid(offerId)) return failure(notFound);
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return failure(notFound);

  const db = getDb();
  const now = deps.now();
  await expireCountersPg(db, now, { offerId });
  const offer = (await offersForOwnerPg(db, id, actor.userId, offerId))[0];
  if (!offer) return failure(notFound);
  if (sameTerms(parsed.value, offer)) {
    return failure({ ok: false, code: "invalid", message: "A counter-offer must change at least one term. To agree to these terms, accept the offer." });
  }
  const { expiresInDays, ...terms } = parsed.value;
  const saved = await ownerCounterPg(db, id, OWNER_COUNTER_FROM, {
    ...terms, offerId, userId: actor.userId, now, expiresAt: counterExpiry(now, expiresInDays)
  });
  if (!saved) return failure(conflict);

  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "formal_offer", aggregateId: offerId, eventType: "offer.countered",
    correlationId: deps.newId(), payload: { listingId: id, counterId: saved.id, round: saved.round, from: offer.status }
  });
  void notifyOfferOutcome(db, offerId, "countered");
  return NextResponse.json({ offer: { id: offerId, status: "countered" }, counter: { id: saved.id, round: saved.round } }, { status: 201 });
}

export const POST = withApi(handlePost);
