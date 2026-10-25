import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../../src/domain/access";
import { awaiting } from "../../../../../../src/domain/offer-counter";
import { isUuid } from "../../../../../../src/domain/offer-decision";
import { getActor, getDb, getDeps } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { countersForOfferPg, expireCountersPg, originalTermsPg } from "../../../../../../src/server/offer-counter-db";
import { offersForOwnerPg } from "../../../../../../src/server/offers-db";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;

/** One offer with its counter-offer history, for the listing's owner or appointed agent. No buyer identity. Others get 404. */
export async function GET(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "offer.analyse");
  if (denied) return failure(denied);
  const { id, offerId } = await params;
  if (!isUuid(offerId)) return failure(notFound);
  const handler = await requireListingHandler(req, id);
  if (handler instanceof NextResponse) return handler;
  const db = getDb();
  await expireCountersPg(db, getDeps().now(), { offerId });
  const offer = (await offersForOwnerPg(db, id, handler.rec.listing.ownerUserId, offerId))[0];
  if (!offer) return failure(notFound);
  return NextResponse.json({
    offer: { ...offer, awaiting: awaiting(offer.status) },
    original: await originalTermsPg(db, offerId),
    counters: await countersForOfferPg(db, offerId),
    canDecide: !handler.asAgent
  });
}
