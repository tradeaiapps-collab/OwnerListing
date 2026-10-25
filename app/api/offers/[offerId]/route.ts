import { NextResponse } from "next/server";
import { awaiting } from "../../../../src/domain/offer-counter";
import { getDb } from "../../../../src/server/context";
import { requireBuyerOffer } from "../../../../src/server/buyer-offer";
import { offerTimelinePg } from "../../../../src/server/offer-timeline-db";
import { countersForOfferPg } from "../../../../src/server/offer-counter-db";

type Ctx = { params: Promise<{ offerId: string }> };

/** The buyer's own offer, its counter-offers and its timeline. Others get 404. */
export async function GET(req: Request, { params }: Ctx) {
  const { offerId } = await params;
  const mine = await requireBuyerOffer(req, offerId);
  if (mine instanceof NextResponse) return mine;
  return NextResponse.json({
    offer: { ...mine.offer, awaiting: awaiting(mine.offer.status) },
    counters: await countersForOfferPg(getDb(), offerId),
    timeline: await offerTimelinePg(getDb(), offerId)
  });
}
