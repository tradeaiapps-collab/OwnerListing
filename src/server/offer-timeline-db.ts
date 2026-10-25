import type { Queryable } from "./db";
import type { TimelineEvent } from "../domain/offer-timeline";

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/**
 * The offer's timeline, oldest first. Callers check access first. Actors are returned by role only ("owner", "buyer",
 * "system"), never by user id, so neither side learns the other's identity from it.
 */
export async function offerTimelinePg(db: Queryable, offerId: string): Promise<TimelineEvent[]> {
  const { rows } = await db.query(
    `SELECT id, event_type, actor_kind, counter_round, price_cents, conditions, settlement_days, deposit_cents, from_status, to_status, occurred_at
     FROM offer_event WHERE offer_id = $1 ORDER BY occurred_at, id LIMIT 500`,
    [offerId]
  );
  return rows.map(r => ({
    id: String(r["id"]),
    type: String(r["event_type"]),
    actor: r["actor_kind"] === "owner" || r["actor_kind"] === "buyer" ? r["actor_kind"] : "system",
    ...(r["counter_round"] !== null && r["counter_round"] !== undefined ? { round: Number(r["counter_round"]) } : {}),
    ...(r["price_cents"] !== null && r["price_cents"] !== undefined ? {
      terms: {
        priceCents: Number(r["price_cents"]),
        conditions: Array.isArray(r["conditions"]) ? (r["conditions"] as unknown[]).map(String) : [],
        settlementDays: Number(r["settlement_days"]),
        depositCents: Number(r["deposit_cents"])
      }
    } : {}),
    ...(r["from_status"] ? { fromStatus: String(r["from_status"]) } : {}),
    ...(r["to_status"] ? { toStatus: String(r["to_status"]) } : {}),
    occurredAt: iso(r["occurred_at"] as Date | string)
  }));
}
