import type { Queryable } from "./db";
import type { OfferLinkRecord } from "../domain/offer-intake";
import type { ActorKind, OfferDetail, OfferEventType, OfferTerms } from "../domain/offer-detail";

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
 * Spends the link, records the offer and its "submitted" history event in ONE statement, so a link works once even under concurrent requests.
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
     ), made AS (
       INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash, submitted_at)
       SELECT $3, buyer_user_id, $4, $5::jsonb, $6, $7, TRUE, token_hash, $2 FROM spent
       RETURNING id, submitted_at, buyer_user_id, price_cents, settlement_days
     ), ev AS (
       INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, price_cents, settlement_days, occurred_at)
       SELECT id, 'submitted', 'buyer', buyer_user_id, price_cents, settlement_days, submitted_at FROM made
     )
     SELECT id, submitted_at FROM made`,
    [o.tokenHash, o.now, o.listingId, o.priceCents, JSON.stringify(o.conditions), o.settlementDays, o.depositCents]
  );
  const r = rows[0];
  return r ? { id: String(r["id"]), submittedAt: iso(r["submitted_at"] as Date | string) } : undefined;
}

/** What an owner sees about an offer. Deliberately no buyer identity (no id, name or email) and nothing from the negotiation mandate. */
export interface OwnerOfferView {
  id: string;
  priceCents: number;
  conditions: string[];
  settlementDays: number;
  depositCents: number;
  status: string;
  submittedAt: string;
}

/** Offers on one listing, newest first. The owner check is part of the query, so another user's listing returns nothing. */
export async function offersForOwnerPg(db: Queryable, listingId: string, ownerUserId: string): Promise<OwnerOfferView[]> {
  const { rows } = await db.query(
    `SELECT o.id, o.price_cents, o.conditions, o.settlement_days, o.deposit_cents, o.status, o.submitted_at
     FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
     WHERE o.listing_id = $1 AND l.owner_user_id = $2
     ORDER BY o.submitted_at DESC LIMIT 200`,
    [listingId, ownerUserId]
  );
  return rows.map(r => ({
    id: String(r["id"]),
    priceCents: Number(r["price_cents"]),
    conditions: Array.isArray(r["conditions"]) ? (r["conditions"] as unknown[]).map(String) : [],
    settlementDays: Number(r["settlement_days"]),
    depositCents: Number(r["deposit_cents"]),
    status: String(r["status"]),
    submittedAt: iso(r["submitted_at"] as Date | string)
  }));
}

const terms = (r: Record<string, unknown>): OfferTerms => ({
  id: String(r["id"]),
  priceCents: Number(r["price_cents"]),
  depositCents: Number(r["deposit_cents"]),
  settlementDays: Number(r["settlement_days"]),
  conditions: Array.isArray(r["conditions"]) ? (r["conditions"] as unknown[]).map(String) : [],
  status: String(r["status"]),
  submittedAt: iso(r["submitted_at"] as Date | string)
});

/**
 * One offer with its history, the buyer's other offers on the listing and their enquiry thread. The listing id is part
 * of every query, so an offer id from another listing finds nothing. Who may call this (owner or appointed agent) is
 * decided by the route before it runs; the buyer's identity never leaves the database.
 */
export async function offerDetailPg(
  db: Queryable, listingId: string, offerId: string
): Promise<Omit<OfferDetail, "listing" | "canDecide"> | undefined> {
  const head = await db.query(
    `SELECT o.id, o.price_cents, o.deposit_cents, o.settlement_days, o.conditions, o.status, o.submitted_at, o.buyer_user_id,
            l.owner_user_id, v.email_verified_at, v.phone_verified_at, v.id_verified_at
     FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
     LEFT JOIN buyer_verification v ON v.user_id = o.buyer_user_id
     WHERE o.id = $1 AND o.listing_id = $2`,
    [offerId, listingId]
  );
  const h = head.rows[0];
  if (!h) return undefined;
  const buyerId = String(h["buyer_user_id"]), ownerId = String(h["owner_user_id"]);
  const [ev, hist, enq] = await Promise.all([
    db.query(`SELECT event_type, actor_kind, occurred_at, price_cents, settlement_days FROM offer_event WHERE offer_id = $1 ORDER BY occurred_at, id`, [offerId]),
    db.query(
      `SELECT id, price_cents, deposit_cents, settlement_days, conditions, status, submitted_at FROM formal_offer
       WHERE listing_id = $1 AND buyer_user_id = $2 ORDER BY submitted_at, id LIMIT 50`,
      [listingId, buyerId]
    ),
    db.query(`SELECT id FROM enquiry WHERE listing_id = $1 AND buyer_user_id = $2`, [listingId, buyerId])
  ]);
  const enquiryId = enq.rows[0] ? String(enq.rows[0]["id"]) : undefined;
  const msgs = enquiryId
    ? (await db.query(
        `SELECT sender_user_id, body, sent_at FROM (
           SELECT sender_user_id, body, sent_at, id FROM enquiry_message WHERE enquiry_id = $1 ORDER BY sent_at DESC, id DESC LIMIT 100
         ) m ORDER BY sent_at, id`,
        [enquiryId]
      )).rows
    : [];
  return {
    offer: terms(h),
    buyer: { emailVerified: h["email_verified_at"] != null, phoneVerified: h["phone_verified_at"] != null, idVerified: h["id_verified_at"] != null },
    events: ev.rows.map(r => ({
      type: String(r["event_type"]) as OfferEventType, actor: String(r["actor_kind"]) as ActorKind, at: iso(r["occurred_at"] as Date | string),
      ...(r["price_cents"] != null ? { priceCents: Number(r["price_cents"]) } : {}),
      ...(r["settlement_days"] != null ? { settlementDays: Number(r["settlement_days"]) } : {})
    })),
    history: hist.rows.map(terms),
    messages: msgs.map(r => {
      const s = r["sender_user_id"] == null ? null : String(r["sender_user_id"]);
      return { from: s === null ? "system" as const : s === buyerId ? "buyer" as const : s === ownerId ? "owner" as const : "agent" as const, body: String(r["body"]), at: iso(r["sent_at"] as Date | string) };
    }),
    ...(enquiryId ? { enquiryId } : {})
  };
}
