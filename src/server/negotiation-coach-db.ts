import type { Queryable } from "./db";
import { DEFAULT_MODEL, featuresOf, trainModel, type CoachModel, type TrainingSample } from "../domain/negotiation-coach";

/**
 * Closed and failed sale offers as feature rows for the learning model. Only numbers and terms come back: no offer, listing,
 * buyer or owner id, so the model learns from the whole platform without anything being traceable to a person.
 * "Closed" = accepted. "Failed" = rejected, withdrawn or expired.
 */
export async function trainingSamplesPg(db: Queryable, limit = 2000): Promise<TrainingSample[]> {
  const r = await db.query(
    `SELECT o.price_cents, o.deposit_cents, o.settlement_days, o.conditions, o.status, l.price_cents AS asking,
       (SELECT COUNT(*) FROM offer_event e WHERE e.offer_id = o.id AND e.event_type IN ('countered','owner_countered','buyer_countered')) AS rounds,
       (SELECT COUNT(*) FROM formal_offer x WHERE x.listing_id = o.listing_id AND x.id <> o.id
          AND x.submitted_at BETWEEN o.submitted_at - interval '30 days' AND o.submitted_at + interval '30 days') AS others,
       EXISTS (SELECT 1 FROM formal_offer p WHERE p.listing_id = o.listing_id AND p.buyer_user_id = o.buyer_user_id
          AND p.submitted_at < o.submitted_at AND p.price_cents < o.price_cents) AS raised
     FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
     WHERE l.transaction_type = 'sale' AND l.price_cents IS NOT NULL AND o.status IN ('accepted','rejected','withdrawn','expired')
     ORDER BY o.submitted_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map(x => ({
    x: featuresOf(
      {
        priceCents: Number(x["price_cents"]), depositCents: Number(x["deposit_cents"]), settlementDays: Number(x["settlement_days"]),
        conditions: Array.isArray(x["conditions"]) ? (x["conditions"] as unknown[]).map(String) : []
      },
      { askingPriceCents: Number(x["asking"]), rounds: Number(x["rounds"]), openOffers: Number(x["others"]) + 1, buyerRaised: x["raised"] === true }
    ),
    y: x["status"] === "accepted" ? 1 : 0
  }));
}

/** The price of the seller's latest counter on this offer, if there is one (the standing ask that concession limits are measured from). */
export async function latestOwnerCounterCentsPg(db: Queryable, offerId: string): Promise<number | undefined> {
  const r = await db.query(
    "SELECT price_cents FROM offer_event WHERE offer_id = $1 AND event_type = 'owner_countered' AND price_cents IS NOT NULL ORDER BY occurred_at DESC, id DESC LIMIT 1",
    [offerId]
  );
  return r.rows[0] ? Number(r.rows[0]["price_cents"]) : undefined;
}

let cached: { at: number; model: CoachModel } | undefined;
const TTL_MS = 10 * 60 * 1000;

/** The model trained on past outcomes, kept for ten minutes. If the query fails the coach still works from its starting weights. */
export async function currentModelPg(db: Queryable, nowMs = Date.now()): Promise<CoachModel> {
  if (cached && nowMs - cached.at < TTL_MS) return cached.model;
  try {
    const model = trainModel(await trainingSamplesPg(db), DEFAULT_MODEL);
    cached = { at: nowMs, model };
    return model;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function resetModelCache(): void { cached = undefined; }
