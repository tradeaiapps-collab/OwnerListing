import { floorAad, toPolicyMandate } from "../domain/mandate";
import { compareOffers, type AnalysisOffer } from "../domain/offer-analysis";
import { openOfferToken } from "../domain/offer-link-crypto";
import type { NegotiationMandate } from "../domain/offers";
import { coach, listingStrategy, OPEN_STATUSES_FOR_STRATEGY, type CoachInput, type CoachModel, type CoachResult, type ListingStrategy } from "../domain/negotiation-coach";
import type { Queryable } from "./db";
import { mandateHistoryPg } from "./mandate-db";
import { latestOwnerCounterCentsPg } from "./negotiation-coach-db";
import { sameBuyerOffersPg } from "./offer-suggestions-db";

const MAX_OTHERS = 8;

/** The seller's negotiation settings with the floor opened. Only ever passed into the coach, never returned to a screen or written to text. */
export async function openMandatePg(db: Queryable, listingId: string): Promise<NegotiationMandate | undefined> {
  const latest = (await mandateHistoryPg(db, listingId))[0];
  const key = process.env["MANDATE_FLOOR_KEY"];
  if (!latest || !key) return undefined;
  try {
    const floor = Number(await openOfferToken(latest.floorSealed, key, floorAad(listingId)));
    return Number.isFinite(floor) && floor > 0 ? toPolicyMandate(latest, floor) : undefined;
  } catch { return undefined; }
}

export interface ListingFacts { transactionType: "sale" | "rent"; askingPriceCents?: number }

export async function coachInputPg(db: Queryable, listingId: string, offer: AnalysisOffer, all: readonly AnalysisOffer[], listing: ListingFacts, mandate?: NegotiationMandate): Promise<CoachInput> {
  const history = await sameBuyerOffersPg(db, listingId, offer.id);
  const standing = await latestOwnerCounterCentsPg(db, offer.id);
  return {
    offer, allOffers: all, buyerHistory: history, counterRound: history.filter(h => h.status === "countered").length, listing,
    ...(mandate ? { mandate } : {}), ...(standing !== undefined ? { standingAskCents: standing } : {})
  };
}

/** Coach for the chosen offer plus the multi-party view over the other open offers on the listing (at most 8 more). */
export async function coachListingPg(db: Queryable, listingId: string, offers: readonly AnalysisOffer[], offerId: string, listing: ListingFacts, model: CoachModel, mandate?: NegotiationMandate): Promise<{ input: CoachInput; result: CoachResult; strategy: ListingStrategy } | undefined> {
  const offer = offers.find(o => o.id === offerId);
  if (!offer) return undefined;
  const input = await coachInputPg(db, listingId, offer, offers, listing, mandate);
  const result = coach(input, model);
  const open = offers.filter(o => OPEN_STATUSES_FOR_STRATEGY.includes(o.status) || o.id === offerId);
  const labels = new Map(compareOffers(open).map(r => [r.id, r.label]));
  const entries = [{ offerId, label: labels.get(offerId) ?? "This offer", coach: result }];
  for (const o of open.filter(x => x.id !== offerId).slice(0, MAX_OTHERS)) {
    entries.push({ offerId: o.id, label: labels.get(o.id) ?? "Offer", coach: coach(await coachInputPg(db, listingId, o, offers, listing, mandate), model) });
  }
  return { input, result, strategy: listingStrategy(entries, listing.askingPriceCents) };
}
