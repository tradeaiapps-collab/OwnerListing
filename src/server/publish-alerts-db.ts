import { alertKey } from "../domain/alerts";
import type { AlertPreference, ListingSummary } from "../domain/buyer";
import type { PropertyListing } from "../domain/listing";
import { createPublishAlertHook } from "../domain/publish-alerts";
import { createUnconfiguredAlertDelivery } from "../adapters/alert-delivery";
import type { Queryable } from "./db";
import { toSearch } from "./saved-search-db";

const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : undefined);
const MAX_SEARCHES_SCANNED = 5000;

/**
 * Narrows saved searches to those that could match a listing. It only drops searches matchesSearch would reject
 * (an empty criteria list means "any"; a listing without price/bedrooms/suburb fails a search that limits it), so matchesSearch stays the final authority.
 * Listing values travel as parameters; the SQL text is constant. A malformed numeric criterion counts as no limit here and is rejected later by toSearch.
 */
export function buildAlertCandidateQuery(l: ListingSummary): { text: string; params: unknown[] } {
  const num = (key: string) => `(CASE WHEN jsonb_typeof(s.criteria->'${key}') = 'number' THEN (s.criteria->>'${key}')::numeric END)`;
  const any = (key: string) => `(jsonb_typeof(s.criteria->'${key}') IS DISTINCT FROM 'array' OR jsonb_array_length(s.criteria->'${key}') = 0`;
  const text = `SELECT s.id, s.buyer_user_id, s.criteria, s.active FROM saved_search s
           JOIN app_user u ON u.id = s.buyer_user_id
          WHERE s.active AND u.status = 'active' AND u.user_type = 'buyer'
            AND s.criteria->>'transactionType' = $1 AND s.criteria->>'useClass' = $2
            AND ${any("jurisdictions")} OR s.criteria->'jurisdictions' @> jsonb_build_array($3::text))
            AND ${any("propertyTypes")} OR s.criteria->'propertyTypes' @> jsonb_build_array($4::text))
            AND ${any("suburbs")} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(s.criteria->'suburbs') x WHERE lower(btrim(x)) = $5::text))
            AND (${num("minPriceCents")} IS NULL OR $6::bigint >= ${num("minPriceCents")})
            AND (${num("maxPriceCents")} IS NULL OR $6::bigint <= ${num("maxPriceCents")})
            AND (${num("minBedrooms")} IS NULL OR $7::int >= ${num("minBedrooms")})
          ORDER BY s.created_at, s.id LIMIT $8`;
  const suburb = l.suburb?.trim().toLowerCase();
  return { text, params: [l.transactionType, l.useClass, l.jurisdiction, l.propertyType, suburb ?? null, l.priceCents ?? null, l.bedrooms ?? null, MAX_SEARCHES_SCANNED] };
}

/** Post-publish alert hook on the database. Delivery uses the fail-closed port, so nothing is sent until a provider is chosen. */
export function createPgPublishAlertHook(db: Queryable): (listing: PropertyListing) => Promise<unknown> {
  return createPublishAlertHook({
    port: createUnconfiguredAlertDelivery(),
    now: () => new Date().toISOString(),
    // The app page where the buyer turns a channel off; with no APP_URL there is no link, so dispatch refuses to send.
    unsubscribeUrlFor: () => {
      const base = process.env["APP_URL"]?.replace(/\/+$/, "");
      return base ? `${base}/buyer/saved-searches` : "";
    },
    async loadSearches(listing) {
      const q = buildAlertCandidateQuery(listing);
      const r = await db.query(q.text, q.params);
      return r.rows.flatMap(row => { const s = toSearch(row); return s ? [s] : []; });
    },
    async loadPrefs(buyerUserIds) {
      const r = await db.query(
        "SELECT buyer_user_id, channel, consent_given_at, unsubscribed_at FROM alert_preference WHERE buyer_user_id = ANY($1::uuid[])",
        [buyerUserIds]);
      const out: Record<string, AlertPreference[]> = {};
      for (const row of r.rows) {
        const buyer = row["buyer_user_id"];
        const channel = row["channel"];
        if (typeof buyer !== "string" || (channel !== "email" && channel !== "sms")) continue;
        const consentGivenAt = iso(row["consent_given_at"]);
        const unsubscribedAt = iso(row["unsubscribed_at"]);
        (out[buyer] ??= []).push({
          channel,
          ...(consentGivenAt !== undefined ? { consentGivenAt } : {}),
          ...(unsubscribedAt !== undefined ? { unsubscribedAt } : {})
        });
      }
      return out;
    },
    async loadHandled(listingId) {
      const r = await db.query("SELECT buyer_user_id, channel, saved_search_id, outcome FROM alert_delivery WHERE listing_id = $1", [listingId]);
      const sentKeys = new Set<string>();
      const searchIds = new Set<string>();
      for (const row of r.rows) {
        if (typeof row["saved_search_id"] === "string") searchIds.add(row["saved_search_id"]);
        if (row["outcome"] === "sent" && (row["channel"] === "email" || row["channel"] === "sms")) {
          sentKeys.add(alertKey(String(row["buyer_user_id"]), row["channel"], listingId));
        }
      }
      return { sentKeys, searchIds };
    },
    async log(e) {
      await db.query(
        `INSERT INTO alert_delivery (buyer_user_id, channel, listing_id, saved_search_id, outcome, attempted_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [e.buyerUserId, e.channel, e.listingId, e.searchId, e.outcome, e.attemptedAt]);
    }
  });
}
