import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../../../src/domain/access";
import { isUuid, nextStatus, parseDecision, statusesAllowing } from "../../../../../../../src/domain/offer-decision";
import { getActor, getDb, getDeps } from "../../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { decideOfferPg, ownerOfferStatusPg } from "../../../../../../../src/server/offer-flow-db";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;
const conflict = { ok: false, code: "conflict", message: "This offer can no longer be changed that way." } as const;

/**
 * The owner accepts, rejects or asks for a counter on an offer. Owner only; the AI has no route here and never accepts.
 * This only records the decision: no money moves and no funds are held (deposits go to the solicitor's trust account).
 */
export async function POST(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.approve");
  if (denied) return failure(denied);
  const { id, offerId } = await params;
  const decision = parseDecision(await req.json().catch(() => null));
  if (!decision) return failure({ ok: false, code: "invalid", message: "Decision must be accept, reject or counter_request." });
  if (!isUuid(offerId)) return failure(notFound);
  const deps = getDeps();
  const rec = await deps.repo.get(id);
  if (!rec || rec.listing.ownerUserId !== actor.userId) return failure(notFound);

  const db = getDb();
  const current = await ownerOfferStatusPg(db, id, offerId, actor.userId);
  if (!current) return failure(notFound);
  const to = nextStatus(current, decision);
  if (!to) return failure(conflict);
  if (!(await decideOfferPg(db, id, offerId, actor.userId, statusesAllowing(decision), to))) return failure(conflict);

  const now = deps.now();
  await deps.appendAudit({
    id: deps.newId(), occurredAt: now, actorType: "user", actorId: actor.userId,
    aggregateType: "formal_offer", aggregateId: offerId, eventType: `offer.${to}`,
    correlationId: deps.newId(), payload: { listingId: id, decision, from: current, to }
  });
  return NextResponse.json({ offer: { id: offerId, status: to } });
}
