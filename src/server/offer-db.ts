import type { OfferLinkRecord } from "../domain/offer-intake";
import type { OfferRecord, OfferRepository, OfferStatus } from "../domain/offer-service";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

function toOffer(r: Record<string, unknown>): OfferRecord {
  const cond = r["conditions"];
  return {
    id: String(r["id"]), listingId: String(r["listing_id"]), buyerUserId: String(r["buyer_user_id"]),
    priceCents: Number(r["price_cents"]), conditions: Array.isArray(cond) ? cond.map(String) : [],
    settlementDays: Number(r["settlement_days"]), depositCents: Number(r["deposit_cents"]),
    status: String(r["status"]) as OfferStatus, submittedAt: iso(r["submitted_at"])
  };
}

/**
 * PostgreSQL offer store. Marking a link used and inserting the offer is one SQL statement, so a link can
 * only ever produce one offer even under concurrent requests. Offer terms are locked by a database trigger.
 */
export function createPgOfferRepository(db: Queryable): OfferRepository {
  return {
    async insertLink(l, createdAt) {
      await db.query(
        "INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)",
        [l.tokenHash, l.listingId, l.buyerUserId, createdAt, l.expiresAt]
      );
    },
    async findLink(tokenHash) {
      const r = await db.query("SELECT * FROM offer_link WHERE token_hash = $1", [tokenHash]);
      const row = r.rows[0];
      if (!row) return undefined;
      const link: OfferLinkRecord = {
        tokenHash: String(row["token_hash"]), listingId: String(row["listing_id"]),
        buyerUserId: String(row["buyer_user_id"]), expiresAt: iso(row["expires_at"]),
        ...(row["used_at"] ? { usedAt: iso(row["used_at"]) } : {})
      };
      return link;
    },
    async submit(o, tokenHash) {
      const r = await db.query(
        `WITH used AS (
           UPDATE offer_link SET used_at = $9::timestamptz
           WHERE token_hash = $1 AND used_at IS NULL AND buyer_user_id = $3::uuid AND listing_id = $2::uuid
           RETURNING token_hash
         )
         INSERT INTO formal_offer (id, listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents,
                                   confirmed_final, link_token_hash, status, submitted_at)
         SELECT $4::uuid, $2::uuid, $3::uuid, $5::bigint, $6::jsonb, $7::int, $8::bigint, true, token_hash, 'submitted', $9::timestamptz
         FROM used
         RETURNING id`,
        [tokenHash, o.listingId, o.buyerUserId, o.id, o.priceCents, JSON.stringify(o.conditions), o.settlementDays, o.depositCents, o.submittedAt]
      );
      return r.rows.length === 1;
    },
    async get(id) {
      const r = await db.query("SELECT * FROM formal_offer WHERE id = $1", [id]);
      return r.rows[0] ? toOffer(r.rows[0]) : undefined;
    },
    async listByListings(ids) {
      if (ids.length === 0) return [];
      const r = await db.query("SELECT * FROM formal_offer WHERE listing_id = ANY($1::uuid[]) ORDER BY submitted_at DESC", [[...ids]]);
      return r.rows.map(toOffer);
    },
    async listByBuyer(buyerUserId) {
      const r = await db.query("SELECT * FROM formal_offer WHERE buyer_user_id = $1 ORDER BY submitted_at DESC", [buyerUserId]);
      return r.rows.map(toOffer);
    },
    async setStatus(id, from, to) {
      const r = await db.query("UPDATE formal_offer SET status = $3 WHERE id = $1 AND status = $2 RETURNING id", [id, from, to]);
      return r.rows.length === 1;
    }
  };
}
