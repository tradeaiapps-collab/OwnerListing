import type { NextResponse } from "next/server";
import { isUuid } from "../domain/offer-decision";
import type { Actor } from "../domain/listing-service";
import { getActor, getDb, getDeps } from "./context";
import { failure, unauthenticated } from "./http";
import { expireCountersPg, offersForBuyerPg, type BuyerOfferView } from "./offer-counter-db";

const notFound = { ok: false, code: "not_found", message: "Offer not found." } as const;

/**
 * The signed-in buyer's own offer (after settling expired counters), or a 401/404 response. Anyone else, including the
 * listing's owner, gets 404 here: owners use the listing routes.
 */
export async function requireBuyerOffer(req: Request, offerId: string): Promise<{ actor: Actor; offer: BuyerOfferView } | NextResponse> {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (actor.userType !== "buyer" || !isUuid(offerId)) return failure(notFound);
  const db = getDb();
  await expireCountersPg(db, getDeps().now(), { offerId, buyerUserId: actor.userId });
  const offer = (await offersForBuyerPg(db, actor.userId, offerId))[0];
  return offer ? { actor, offer } : failure(notFound);
}
