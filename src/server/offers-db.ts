import type { Queryable } from "./db";
import type { OfferLinkRecord } from "../domain/offer-intake";

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** The stored link for a token hash, or undefined. Only the hash is ever looked up; the raw token is never stored. */
export async function offerLinkPg(db: Queryable, tokenHash: string): Promise<OfferLinkRecord | undefined> {
  const { rows } = await db.query(
    "SELECT token_hash, listing_id, buyer_user_id, expires_at, used_at FROM offer_link WHERE token_hash = $1",
    [tokenHash]
  );
  const r = rows[0];
  if (!r) return undefined;
  return {
    tokenHash: String(r["token_hash"]),
    listingId: String(r["listing_id"]),
    buyerUserId: String(r["buyer_user_id"]),
    expiresAt: iso(r["expires_at"] as Date | string),
    ...(r["used_at"] ? { usedAt: iso(r["used_at"] as Date | string) } : {})
  };
}

export interface NewOffer {
  tokenHash: string;
  listingId: string;
  priceCents: number;
  conditions: readonly string[];
  settlementDays: number;
  depositCents: number;
  now: string;
}

/**
 * Spends the link and records the offer in ONE statement, so a link works once even under concurrent requests.
 * The buyer comes from the link row, never from the request. Returns the new offer id, or undefined when the link
 * was no longer valid (already used, expired, or for another listing).
 */
export async function submitOfferPg(db: Queryable, o: NewOffer): Promise<{ id: string; submittedAt: string } | undefined> {
  const { rows } = await db.query(
    `WITH spent AS (
       UPDATE offer_link SET used_at = $2
       WHERE token_hash = $1 AND listing_id = $3 AND used_at IS NULL AND expires_at > $2
       RETURNING token_hash, buyer_user_id
     ), wipe AS (
       UPDATE offer_link_request SET link_ciphertext = NULL WHERE token_hash IN (SELECT token_hash FROM spent)
     )
     INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash)
     SELECT $3, buyer_user_id, $4, $5::jsonb, $6, $7, TRUE, token_hash FROM spent
     RETURNING id, submitted_at`,
    [o.tokenHash, o.now, o.listingId, o.priceCents, JSON.stringify(o.conditions), o.settlementDays, o.depositCents]
  );
  const r = rows[0];
  return r ? { id: String(r["id"]), submittedAt: iso(r["submitted_at"] as Date | string) } : undefined;
}

/**
 * What an owner sees about an offer. Deliberately no buyer identity (no id, name or email) and nothing from the negotiation mandate.
 * The terms are the buyer's standing terms: once accepted, the accepted ones; otherwise the buyer's latest counter (or an owner
 * counter the buyer agreed to), falling back to the original offer. `round` counts counters so far.
 */
export interface OwnerOfferView {
  id: string;
  priceCents: number;
  conditions: string[];
  settlementDays: number;
  depositCents: number;
  status: string;
  submittedAt: string;
  round: number;
  /** The owner's own counter waiting for the buyer, if any. */
  openCounter?: { id: string; priceCents: number; depositCents: number; settlementDays: number; conditions: string[]; expiresAt: string };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Offers on one listing, newest first. The owner check is part of the query, so another user's listing returns nothing. */
export async function offersForOwnerPg(db: Queryable, listingId: string, ownerUserId: string, offerId?: string): Promise<OwnerOfferView[]> {
  const { rows } = await db.query(
    `SELECT o.id, o.status, o.submitted_at,
       COALESCE(t.price_cents, o.price_cents) AS price_cents, COALESCE(t.conditions, o.conditions) AS conditions,
       COALESCE(t.settlement_days, o.settlement_days) AS settlement_days, COALESCE(t.deposit_cents, o.deposit_cents) AS deposit_cents,
       (SELECT count(*) FROM offer_counter n WHERE n.offer_id = o.id) AS round,
       oc.id AS oc_id, oc.price_cents AS oc_price_cents, oc.deposit_cents AS oc_deposit_cents,
       oc.settlement_days AS oc_settlement_days, oc.conditions AS oc_conditions, oc.expires_at AS oc_expires_at
     FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
     LEFT JOIN LATERAL (
       SELECT c.price_cents, c.conditions, c.settlement_days, c.deposit_cents FROM offer_counter c
       WHERE c.offer_id = o.id AND CASE WHEN o.status = 'accepted' THEN c.id = o.accepted_counter_id
                                        ELSE c.from_party = 'buyer' OR c.status = 'agreed' END
       ORDER BY c.round DESC LIMIT 1
     ) t ON TRUE
     LEFT JOIN offer_counter oc ON oc.offer_id = o.id AND oc.status = 'open' AND oc.from_party = 'owner'
     WHERE o.listing_id = $1 AND l.owner_user_id = $2${offerId === undefined ? "" : " AND o.id = $3"}
     ORDER BY o.submitted_at DESC LIMIT 200`,
    offerId === undefined ? [listingId, ownerUserId] : [listingId, ownerUserId, offerId]
  );
  return rows.map(r => ({
    id: String(r["id"]),
    priceCents: Number(r["price_cents"]),
    conditions: strings(r["conditions"]),
    settlementDays: Number(r["settlement_days"]),
    depositCents: Number(r["deposit_cents"]),
    status: String(r["status"]),
    submittedAt: iso(r["submitted_at"] as Date | string),
    round: Number(r["round"] ?? 0),
    ...(r["oc_id"] ? {
      openCounter: {
        id: String(r["oc_id"]),
        priceCents: Number(r["oc_price_cents"]),
        depositCents: Number(r["oc_deposit_cents"]),
        settlementDays: Number(r["oc_settlement_days"]),
        conditions: strings(r["oc_conditions"]),
        expiresAt: iso(r["oc_expires_at"] as Date | string)
      }
    } : {})
  }));
}
