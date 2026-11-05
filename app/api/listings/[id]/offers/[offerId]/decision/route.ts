import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../../../src/domain/access";
import { isUuid, nextStatus, parseDecision, statusesAllowing } from "../../../../../../../src/domain/offer-decision";
import { getActor, getDb, getDeps } from "../../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { decideOfferPg, ownerOfferStatusPg } from "../../../../../../../src/server/offer-flow-db";
import { csrfGuard } from "../../../../../../../src/server/csrf";
import { CAN_EXPIRE } from "../../../../../../../src/domain/offer-counter";
import { expireCountersPg } from "../../../../../../../src/server/offer-counter-db";
import { recordAcceptedOfferEventPg } from "../../../../../../../src/server/sale-events-db";
import { notifyOfferBuyer } from "../../../../../../../src/server/notifier";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { requireRecentMfa } from "../../../../../../../src/server/mfa-context";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;
const conflict = { ok: false, code: "conflict", message: "This offer can no longer be changed that way. If your counter-offer is waiting for the buyer, wait for their answer or for it to expire." } as const;

/**
 * The owner accepts, rejects or asks for a counter on an offer. Owner only; the AI has no route here and never accepts.
 * This only records the decision: no money moves and no funds are held (deposits go to the solicitor's trust account).
 * Accepting needs a second-factor check in the last 15 minutes (403 mfa_required otherwise).
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.approve");
  if (denied) return failure(denied);
  const { id, offerId } = await params;
  const decision = parseDecision(await req.json().catch(() => null));
  if (!decision) return failure({ ok: false, code: "invalid", message: "Decision must be accept, reject or counter_request." });
  if (decision === "accept") {
    const stale = await requireRecentMfa(req);
    if (stale) return stale;
  }
  if (!isUuid(offerId)) return failure(notFound);
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return failure(notFound);

  const db = getDb();
  const now = deps.now();
  let current = await ownerOfferStatusPg(db, id, offerId, actor.userId);
  if (!current) return failure(notFound);
  // A counter may have run out of time since the owner last looked: settle that first.
  if (CAN_EXPIRE.includes(current) && (await expireCountersPg(db, now, { offerId })).length > 0) current = "expired";
  const to = nextStatus(current, decision);
  if (!to) return failure(conflict);
  if (!(await decideOfferPg(db, id, offerId, actor.userId, statusesAllowing(decision), to, now))) return failure(conflict);

  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "formal_offer", aggregateId: offerId, eventType: `offer.${to}`,
    correlationId: deps.newId(), payload: { listingId: id, decision, from: current, to }
  });
  // An accepted offer is a sold or rented event for market data. A failure here never undoes the owner's decision:
  // staff can sweep any accepted offer still missing its event from /staff/sale-events.
  if (to === "accepted") await recordAcceptedOfferEventPg(db, offerId).catch(() => false);
  await notifyOfferBuyer(db, offerId, to === "accepted" ? "offer_accepted" : to === "rejected" ? "offer_rejected" : "offer_countered");
  return NextResponse.json({ offer: { id: offerId, status: to } });
}

export const POST = withApi(handlePost);
