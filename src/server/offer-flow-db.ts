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
 * Moves the status and writes the matching offer_event in one guarded statement, so the history can never miss a
 * decision. No row back means it changed under us. Moves no money. `to` is accepted, rejected or countered.
 */
export async function decideOfferPg(
  db: Queryable, listingId: string, offerId: string, ownerUserId: string, from: string[], to: string
): Promise<boolean> {
  const r = await db.query(
    `WITH upd AS (
       UPDATE formal_offer o SET status = $5 FROM property_listing l
       WHERE o.id = $1 AND o.listing_id = $2 AND l.id = o.listing_id AND l.owner_user_id = $3 AND o.status = ANY($4::text[])
       RETURNING o.id
     ), ev AS (
       INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id) SELECT id, $5, 'owner', $3 FROM upd
     )
     SELECT id FROM upd`,
    [offerId, listingId, ownerUserId, from, to]
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
