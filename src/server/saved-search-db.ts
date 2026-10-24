import type { AlertPreference, SavedSearch } from "../domain/buyer";
import { parseSavedSearchInput, type SavedSearchInput, type SavedSearchRepository } from "../domain/saved-search-service";
import type { Queryable } from "./db";

const iso = (v: unknown): string | undefined =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : undefined;

/** The criteria column holds property facts only, so it is stored exactly as the validated input. */
const criteriaOf = (i: SavedSearchInput): string => JSON.stringify({
  transactionType: i.transactionType, useClass: i.useClass,
  jurisdictions: i.jurisdictions, suburbs: i.suburbs, propertyTypes: i.propertyTypes,
  ...(i.minPriceCents !== undefined ? { minPriceCents: i.minPriceCents } : {}),
  ...(i.maxPriceCents !== undefined ? { maxPriceCents: i.maxPriceCents } : {}),
  ...(i.minBedrooms !== undefined ? { minBedrooms: i.minBedrooms } : {})
});

/** Re-validates stored criteria with the same parser, so a malformed row is skipped rather than trusted. */
export function toSearch(row: Record<string, unknown>): SavedSearch | undefined {
  const parsed = parseSavedSearchInput(row["criteria"]);
  if (!parsed.ok || typeof row["id"] !== "string" || typeof row["buyer_user_id"] !== "string") return undefined;
  return { id: row["id"], buyerUserId: row["buyer_user_id"], active: row["active"] === true, ...parsed.value };
}

/** Every query is parameterised and scoped to one buyer's user id. */
export function createPgSavedSearchRepository(db: Queryable): SavedSearchRepository {
  return {
    async list(buyerUserId) {
      const r = await db.query(
        "SELECT id, buyer_user_id, criteria, active FROM saved_search WHERE buyer_user_id = $1 ORDER BY created_at DESC LIMIT 50",
        [buyerUserId]
      );
      return r.rows.flatMap(row => { const s = toSearch(row); return s ? [s] : []; });
    },
    async insert(buyerUserId, input) {
      const r = await db.query(
        "INSERT INTO saved_search (buyer_user_id, criteria, active) VALUES ($1, $2::jsonb, true) RETURNING id",
        [buyerUserId, criteriaOf(input)]
      );
      const id = r.rows[0]?.["id"];
      if (typeof id !== "string") throw new Error("Saved search was not created.");
      return { id, buyerUserId, active: true, ...input };
    },
    async listPreferences(buyerUserId) {
      const r = await db.query(
        "SELECT channel, consent_given_at, unsubscribed_at FROM alert_preference WHERE buyer_user_id = $1 ORDER BY channel",
        [buyerUserId]
      );
      return r.rows.flatMap((row): AlertPreference[] => {
        const channel = row["channel"];
        if (channel !== "email" && channel !== "sms") return [];
        const consentGivenAt = iso(row["consent_given_at"]);
        const unsubscribedAt = iso(row["unsubscribed_at"]);
        return [{
          channel,
          ...(consentGivenAt !== undefined ? { consentGivenAt } : {}),
          ...(unsubscribedAt !== undefined ? { unsubscribedAt } : {})
        }];
      });
    },
    async giveConsent(buyerUserId, channel, nowIso) {
      await db.query(
        `INSERT INTO alert_preference (buyer_user_id, channel, consent_given_at, unsubscribed_at)
         VALUES ($1, $2, $3, NULL)
         ON CONFLICT (buyer_user_id, channel) DO UPDATE SET consent_given_at = $3, unsubscribed_at = NULL`,
        [buyerUserId, channel, nowIso]
      );
    },
    async unsubscribe(buyerUserId, channel, nowIso) {
      await db.query(
        `INSERT INTO alert_preference (buyer_user_id, channel, consent_given_at, unsubscribed_at)
         VALUES ($1, $2, NULL, $3)
         ON CONFLICT (buyer_user_id, channel) DO UPDATE SET unsubscribed_at = $3`,
        [buyerUserId, channel, nowIso]
      );
    }
  };
}
