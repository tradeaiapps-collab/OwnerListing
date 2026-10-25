import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../../src/domain/access";
import { awaiting } from "../../../../../../src/domain/offer-counter";
import { isUuid } from "../../../../../../src/domain/offer-decision";
import type { OfferDetail } from "../../../../../../src/domain/offer-detail";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { failure } from "../../../../../../src/server/http";
import { countersForOfferPg, expireCountersPg } from "../../../../../../src/server/offer-counter-db";
import { offerTimelinePg } from "../../../../../../src/server/offer-timeline-db";
import { offerDetailPg, offersForOwnerPg } from "../../../../../../src/server/offers-db";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;

/**
 * One offer for the listing's owner or its appointed agent: terms, history, the buyer's earlier offers on this listing
 * and their enquiry thread, plus the counter-offer state (`negotiation`) and the full timeline with terms. No buyer
 * identity and nothing from the negotiation mandate. Only the owner gets canDecide. Everyone else gets 404, the same as
 * an unknown offer. A counter that ran out of time is settled first, so the page never shows a stale open counter.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id, offerId } = await params;
  const handler = await requireListingHandler(req, id);
  if (handler instanceof NextResponse) return handler;
  const denied = forbiddenFor({ id: handler.actor.userId, role: handler.actor.userType }, "offer.analyse");
  if (denied) return failure(denied);
  if (!isUuid(offerId)) return failure(notFound);
  const db = getDb();
  await expireCountersPg(db, getDeps().now(), { offerId, listingId: id });
  const d = await offerDetailPg(db, id, offerId);
  if (!d) return failure(notFound);
  const standing = (await offersForOwnerPg(db, id, handler.rec.listing.ownerUserId, offerId))[0];
  const l = handler.rec.listing;
  const detail: OfferDetail = {
    ...d,
    listing: { id: l.id, title: l.title, address: l.address, transactionType: l.transactionType, ...(l.priceCents !== undefined ? { askingPriceCents: l.priceCents } : {}) },
    canDecide: !handler.asAgent
  };
  return NextResponse.json({
    ...detail,
    negotiation: {
      awaiting: awaiting(d.offer.status),
      // The buyer's terms on the table now: their latest counter, an owner counter they agreed to, or the original offer.
      standing: standing
        ? { priceCents: standing.priceCents, depositCents: standing.depositCents, settlementDays: standing.settlementDays, conditions: standing.conditions }
        : { priceCents: d.offer.priceCents, depositCents: d.offer.depositCents, settlementDays: d.offer.settlementDays, conditions: d.offer.conditions },
      round: standing?.round ?? 0,
      ...(standing?.openCounter ? { openCounter: standing.openCounter } : {}),
      counters: await countersForOfferPg(db, offerId),
      timeline: await offerTimelinePg(db, offerId)
    }
  }, { headers: { "cache-control": "private, no-store" } });
}
