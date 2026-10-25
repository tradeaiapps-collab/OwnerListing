import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../../../src/domain/access";
import { isUuid } from "../../../../../../src/domain/offer-decision";
import type { OfferDetail } from "../../../../../../src/domain/offer-detail";
import { getDb } from "../../../../../../src/server/context";
import { failure } from "../../../../../../src/server/http";
import { offerDetailPg } from "../../../../../../src/server/offers-db";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";

type Ctx = { params: Promise<{ id: string; offerId: string }> };

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;

/**
 * One offer for the listing's owner or its appointed agent: terms, history, the buyer's earlier offers on this listing
 * and their enquiry thread. No buyer identity and nothing from the negotiation mandate. Only the owner gets canDecide.
 * Everyone else gets 404, the same as an unknown offer.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { id, offerId } = await params;
  const handler = await requireListingHandler(req, id);
  if (handler instanceof NextResponse) return handler;
  const denied = forbiddenFor({ id: handler.actor.userId, role: handler.actor.userType }, "offer.analyse");
  if (denied) return failure(denied);
  if (!isUuid(offerId)) return failure(notFound);
  const d = await offerDetailPg(getDb(), id, offerId);
  if (!d) return failure(notFound);
  const l = handler.rec.listing;
  const detail: OfferDetail = {
    ...d,
    listing: { id: l.id, title: l.title, address: l.address, transactionType: l.transactionType, ...(l.priceCents !== undefined ? { askingPriceCents: l.priceCents } : {}) },
    canDecide: !handler.asAgent
  };
  return NextResponse.json(detail, { headers: { "cache-control": "private, no-store" } });
}
