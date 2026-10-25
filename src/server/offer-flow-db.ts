import type { Queryable } from "./db";
import type { OfferLinkRecord } from "../domain/offer-intake";

/** True only for an active buyer who has verified email, phone and ID, and who is not the listing's owner. */
export async function eligibleBuyerPg(db: Queryable, buyerUserId: string, ownerUserId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT u.id FROM app_user u JOIN buyer_verification v ON v.user_id = u.id
     WHERE u.id = $1 AND u.id <> $2 AND u.user_type = 'buyer' AND u.status = 'active'
       AND v.email_verified_at IS NOT NULL AND v.phone_verified_at IS NOT NULL AND v.id_verified_at IS NOT NULL`,
    [buyerUserId, ownerUserId]
  );
  return r.rows.length === 1;
}

/** Stores only the token hash. The raw token never reaches the database. */
export async function issueOfferLinkPg(db: Queryable, rec: OfferLinkRecord, createdAt: string): Promise<void> {
  await db.query(
    `INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [rec.tokenHash, rec.listingId, rec.buyerUserId, createdAt, rec.expiresAt]
  );
}

/** Current status of an offer, only if the listing belongs to this owner. */
export async function ownerOfferStatusPg(db: Queryable, listingId: string, offerId: string, ownerUserId: string): Promise<string | undefined> {
  const r = await db.query(
    `SELECT o.status FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
     WHERE o.id = $1 AND o.listing_id = $2 AND l.owner_user_id = $3`,
    [offerId, listingId, ownerUserId]
  );
  const s = r.rows[0]?.["status"];
  return typeof s === "string" ? s : undefined;
}

/**
 * Moves the status in one guarded statement. No row back means it changed under us. Moves no money.
 * Accepting is refused while the owner's own counter waits for the buyer. On accept, the terms accepted are the buyer's
 * latest (their open counter, an owner counter they agreed to, or else their original offer); any open counter closes.
 */
export async function decideOfferPg(
  db: Queryable, listingId: string, offerId: string, ownerUserId: string, from: string[], to: string, now: string
): Promise<boolean> {
  const r = await db.query(
    `WITH target AS (
       SELECT o.id, o.status AS from_status, o.price_cents, o.conditions, o.settlement_days, o.deposit_cents
       FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
       WHERE o.id = $1 AND o.listing_id = $2 AND l.owner_user_id = $3 AND o.status = ANY($4::text[])
         AND ($5 <> 'accepted' OR NOT EXISTS (
           SELECT 1 FROM offer_counter c WHERE c.offer_id = o.id AND c.status = 'open' AND c.from_party = 'owner'))
       FOR UPDATE OF o
     ), basis AS (
       SELECT c.id, c.round, c.price_cents, c.conditions, c.settlement_days, c.deposit_cents
       FROM offer_counter c JOIN target t ON t.id = c.offer_id
       WHERE (c.status = 'open' AND c.from_party = 'buyer') OR c.status = 'agreed'
       ORDER BY c.round DESC LIMIT 1
     ), closed AS (
       UPDATE offer_counter c SET status = CASE WHEN $5 = 'accepted' THEN 'accepted' ELSE 'rejected' END, closed_at = $6
       FROM target t WHERE c.offer_id = t.id AND c.status = 'open' AND $5 IN ('accepted', 'rejected')
       RETURNING c.id
     ), moved AS (
       UPDATE formal_offer o SET status = $5,
         accepted_counter_id = CASE WHEN $5 = 'accepted' THEN (SELECT id FROM basis) ELSE o.accepted_counter_id END
       FROM target t WHERE o.id = t.id
       RETURNING o.id
     )
     -- The timeline row: an acceptance carries the terms accepted (the basis counter, or the original offer).
     INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, counter_id, counter_round,
       price_cents, conditions, settlement_days, deposit_cents, from_status, to_status, occurred_at)
     SELECT m.id, CASE $5 WHEN 'countered' THEN 'counter_requested' ELSE $5 END, 'owner', $3,
       b.id, b.round,
       CASE WHEN $5 = 'accepted' THEN COALESCE(b.price_cents, t.price_cents) END,
       CASE WHEN $5 = 'accepted' THEN COALESCE(b.conditions, t.conditions) END,
       CASE WHEN $5 = 'accepted' THEN COALESCE(b.settlement_days, t.settlement_days) END,
       CASE WHEN $5 = 'accepted' THEN COALESCE(b.deposit_cents, t.deposit_cents) END,
       t.from_status, $5, $6
     FROM moved m JOIN target t ON t.id = m.id LEFT JOIN basis b ON $5 = 'accepted'
     RETURNING offer_id AS id`,
    [offerId, listingId, ownerUserId, from, to, now]
  );
  return r.rows.length === 1;
}

/** Counts one hit in a fixed window and returns the new count. undefined if the store gave nothing usable. */
export async function countHitPg(db: Queryable, bucket: string, windowStartIso: string): Promise<number | undefined> {
  const r = await db.query(
    `INSERT INTO offer_submit_attempt (bucket, window_start, hits) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = offer_submit_attempt.hits + 1
     RETURNING hits`,
    [bucket, windowStartIso]
  );
  const h = Number(r.rows[0]?.["hits"]);
  return Number.isFinite(h) ? h : undefined;
}
