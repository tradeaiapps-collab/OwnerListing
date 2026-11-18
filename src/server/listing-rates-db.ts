import type { ListingRates, RatePeriod } from "../domain/listing-rates";
import type { Queryable } from "./db";

export async function getRatesPg(db: Queryable, listingId: string): Promise<ListingRates | null> {
  const { rows } = await db.query(
    `SELECT council_cents, council_period, water_cents, water_period, water_usage_billed_separately, to_char(as_at, 'YYYY-MM-DD') AS as_at
       FROM listing_rates WHERE listing_id = $1`, [listingId]);
  const r = rows[0];
  if (!r) return null;
  const out: ListingRates = {};
  if (r["council_cents"] !== null) out.council = { cents: Number(r["council_cents"]), period: r["council_period"] as RatePeriod };
  if (r["water_cents"] !== null) out.water = { cents: Number(r["water_cents"]), period: r["water_period"] as RatePeriod };
  if (r["water_usage_billed_separately"] !== null) out.waterUsageBilledSeparately = r["water_usage_billed_separately"] as boolean;
  if (r["as_at"] !== null) out.asAt = r["as_at"] as string;
  return out;
}

/** Replaces the listing's rates; an empty set removes the row. */
export async function saveRatesPg(db: Queryable, listingId: string, rates: ListingRates, userId: string, now: string): Promise<void> {
  if (rates.council === undefined && rates.water === undefined && rates.waterUsageBilledSeparately === undefined) {
    await db.query("DELETE FROM listing_rates WHERE listing_id = $1", [listingId]);
    return;
  }
  await db.query(
    `INSERT INTO listing_rates (listing_id, council_cents, council_period, water_cents, water_period, water_usage_billed_separately, as_at, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (listing_id) DO UPDATE SET council_cents=$2, council_period=$3, water_cents=$4, water_period=$5,
       water_usage_billed_separately=$6, as_at=$7, updated_by=$8, updated_at=$9`,
    [listingId, rates.council?.cents ?? null, rates.council?.period ?? null, rates.water?.cents ?? null, rates.water?.period ?? null,
     rates.waterUsageBilledSeparately ?? null, rates.asAt ?? null, userId, now]);
}
