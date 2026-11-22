import { sellerBundle, SELLER_NOTE, type PricingAdvice, type SellerGoal, type SellerSubject } from "../domain/seller-insights";
import { groupOf, type Comparable } from "../domain/price-guidance";
import type { Queryable } from "./db";

const TTL_MS = 6 * 3_600_000;
const METRICS = ["comparable_sales", "price_trend", "days_on_market", "price_days"] as const;
type Bundle = ReturnType<typeof sellerBundle>;

/** One cache row per area, property group and size band, so a row never answers for a different kind of property. */
export function areaKey(s: SellerSubject): string {
  const band = s.areaSqm ? String(Math.round(s.areaSqm / 50) * 50) : "any";
  return `sale|${groupOf(s.propertyType)}|${(s.suburb ?? "").trim().toLowerCase()}|${s.postcode ?? ""}|${band}`.slice(0, 200);
}

/**
 * The seller figures for an area: fresh cached rows when all four exist, otherwise worked out from `load()` (the comparables source)
 * and stored for six hours. A cache failure never fails the request. Parameterised SQL only.
 */
export async function getSellerInsights(db: Queryable, s: SellerSubject, now: string, load: () => Promise<Comparable[]>): Promise<Bundle> {
  const key = areaKey(s);
  try {
    const r = await db.query("SELECT metric_type, data FROM market_insights_cache WHERE area_key = $1 AND expires_at > $2::timestamptz", [key, now]);
    const got = new Map(r.rows.map(x => [String(x["metric_type"]), x["data"]]));
    if (METRICS.every(m => got.has(m))) {
      return { comparables: got.get("comparable_sales"), trend: got.get("price_trend"), daysOnMarket: got.get("days_on_market"), pricingGuide: got.get("price_days"), note: SELLER_NOTE } as Bundle;
    }
  } catch { /* fall through to a fresh calculation */ }
  const bundle = sellerBundle(s, await load(), now);
  const parts: [typeof METRICS[number], unknown][] = [
    ["comparable_sales", bundle.comparables], ["price_trend", bundle.trend], ["days_on_market", bundle.daysOnMarket], ["price_days", bundle.pricingGuide]
  ];
  try {
    const expires = new Date(Date.parse(now) + TTL_MS).toISOString();
    for (const [m, data] of parts) {
      await db.query(
        `INSERT INTO market_insights_cache (area_key, metric_type, data, calculated_at, expires_at) VALUES ($1,$2,$3::jsonb,$4::timestamptz,$5::timestamptz)
         ON CONFLICT (area_key, metric_type) DO UPDATE SET data = EXCLUDED.data, calculated_at = EXCLUDED.calculated_at, expires_at = EXCLUDED.expires_at`,
        [key, m, JSON.stringify(data), now, expires]);
    }
  } catch { /* cache is best effort */ }
  return bundle;
}

export interface StoredPreference { goal: SellerGoal; recommendedCents?: number; rationale?: string; updatedAt: string }

export async function getPricingPreference(db: Queryable, listingId: string): Promise<StoredPreference | undefined> {
  const x = (await db.query("SELECT * FROM seller_pricing_preferences WHERE listing_id = $1::uuid", [listingId])).rows[0];
  if (!x) return undefined;
  return {
    goal: String(x["seller_goal"]) as SellerGoal, ...(x["recommended_price_cents"] != null ? { recommendedCents: Number(x["recommended_price_cents"]) } : {}),
    ...(x["recommended_price_rationale"] ? { rationale: String(x["recommended_price_rationale"]) } : {}),
    updatedAt: x["updated_at"] instanceof Date ? x["updated_at"].toISOString() : String(x["updated_at"])
  };
}

/** One row per listing: the latest goal and the advice shown for it (cleared when there was not enough data to advise). */
export async function savePricingPreference(db: Queryable, listingId: string, goal: SellerGoal, advice: PricingAdvice | undefined, now: string): Promise<void> {
  await db.query(
    `INSERT INTO seller_pricing_preferences (listing_id, seller_goal, recommended_price_cents, recommended_price_rationale, updated_at)
     VALUES ($1::uuid,$2,$3,$4,$5::timestamptz)
     ON CONFLICT (listing_id) DO UPDATE SET seller_goal = EXCLUDED.seller_goal, recommended_price_cents = EXCLUDED.recommended_price_cents,
       recommended_price_rationale = EXCLUDED.recommended_price_rationale, updated_at = EXCLUDED.updated_at`,
    [listingId, goal, advice?.recommendedCents ?? null, advice?.rationale ?? null, now]);
}
