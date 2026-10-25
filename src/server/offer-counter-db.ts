import type { Queryable } from "./db";
import { MAX_COUNTER_ROUNDS, type CounterTerms } from "../domain/offer-counter";

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export interface NewCounter extends CounterTerms {
  offerId: string;
  /** The signed-in user making the counter, from the session. */
  userId: string;
  now: string;
  expiresAt: string;
}

export interface CounterView extends CounterTerms {
  id: string;
  round: number;
  fromParty: "owner" | "buyer";
  status: string;
  createdAt: string;
  expiresAt: string;
  closedAt?: string;
}

/**
 * Closes open counters whose reply time has passed and marks their offers expired. Scoped to one offer, one listing or one
 * buyer so each read and action settles its own offers first; with no scope it sweeps everything (for a scheduled job).
 * Returns the ids of the offers that expired.
 */
export async function expireCountersPg(
  db: Queryable, now: string, scope: { offerId?: string; listingId?: string; buyerUserId?: string } = {}
): Promise<string[]> {
  // Every part of one statement reads the same snapshot, so formal_offer read in the final INSERT still shows the old status.
  const r = await db.query(
    `WITH exp AS (
       UPDATE offer_counter c SET status = 'expired', closed_at = c.expires_at
       FROM formal_offer f
       WHERE f.id = c.offer_id AND c.status = 'open' AND c.expires_at <= $1
         AND ($2::uuid IS NULL OR f.id = $2) AND ($3::uuid IS NULL OR f.listing_id = $3) AND ($4::uuid IS NULL OR f.buyer_user_id = $4)
       RETURNING c.offer_id, c.id, c.round, c.expires_at
     ), moved AS (
       UPDATE formal_offer f SET status = 'expired' FROM exp
       WHERE f.id = exp.offer_id AND f.status IN ('countered', 'buyer_countered')
       RETURNING f.id
     )
     INSERT INTO offer_event (offer_id, event_type, actor_kind, counter_id, counter_round, from_status, to_status, occurred_at)
     SELECT m.id, 'expired', 'system', exp.id, exp.round, f.status, 'expired', exp.expires_at
     FROM moved m JOIN exp ON exp.offer_id = m.id JOIN formal_offer f ON f.id = m.id
     RETURNING offer_id AS id`,
    [now, scope.offerId ?? null, scope.listingId ?? null, scope.buyerUserId ?? null]
  );
  return r.rows.map(x => String(x["id"]));
}

/** A concurrent write that lost the race (round taken, or another counter opened) is a refusal, not a server error. */
async function lostRace<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "23505" || code === "23P01") return undefined;
    throw e;
  }
}

/** Stores the counter and its timeline event. Needs CTEs `target` (id, from_status) and `moved` (id) before it. */
const INSERT_COUNTER = (party: "owner" | "buyer") => `, ins AS (
    INSERT INTO offer_counter (offer_id, round, from_party, created_by, price_cents, conditions, settlement_days, deposit_cents, created_at, expires_at)
    SELECT m.id, (SELECT COALESCE(MAX(round), 0) + 1 FROM offer_counter WHERE offer_id = m.id), '${party}', $3, $4, $5::jsonb, $6, $7, $8, $9
    FROM moved m
    RETURNING id, offer_id, round
  )
  INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, counter_id, counter_round,
    price_cents, conditions, settlement_days, deposit_cents, from_status, to_status, occurred_at)
  SELECT i.offer_id, '${party === "owner" ? "owner_countered" : "buyer_countered"}', '${party}', $3, i.id, i.round, $4, $5::jsonb, $6, $7,
    t.from_status, '${party === "owner" ? "countered" : "buyer_countered"}', $8
  FROM ins i JOIN target t ON t.id = i.offer_id
  RETURNING counter_id AS id, counter_round AS round`;

/**
 * The owner's counter, in one statement: checks ownership, whose turn it is and the round limit, closes the buyer's open
 * counter, moves the offer to "countered" and stores the new terms. `c.userId` is the owner, from the session. undefined when any check failed (or it changed under us).
 */
export async function ownerCounterPg(
  db: Queryable, listingId: string, from: readonly string[], c: NewCounter
): Promise<{ id: string; round: number } | undefined> {
  const r = await lostRace(db.query(
    `WITH target AS (
       SELECT o.id, o.status AS from_status FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
       WHERE o.id = $1 AND o.listing_id = $2 AND l.owner_user_id = $3 AND o.status = ANY($10::text[])
         AND (SELECT count(*) FROM offer_counter x WHERE x.offer_id = o.id) < $11
       FOR UPDATE OF o
     ), closed AS (
       UPDATE offer_counter x SET status = 'countered', closed_at = $8
       FROM target t WHERE x.offer_id = t.id AND x.status = 'open' AND x.from_party = 'buyer'
       RETURNING x.id
     ), moved AS (
       UPDATE formal_offer o SET status = 'countered' FROM target t WHERE o.id = t.id RETURNING o.id
     )${INSERT_COUNTER("owner")}`,
    [c.offerId, listingId, c.userId, c.priceCents, JSON.stringify(c.conditions), c.settlementDays, c.depositCents, c.now, c.expiresAt,
      [...from], MAX_COUNTER_ROUNDS]
  ));
  const row = r?.rows[0];
  return row ? { id: String(row["id"]), round: Number(row["round"]) } : undefined;
}

/**
 * The buyer's counter, in one statement: only the buyer the offer belongs to, only on their turn, only while the listing is
 * published and the owner's counter (if any) has not expired. Closes the owner's open counter and moves the offer to
 * "buyer_countered".
 */
export async function buyerCounterPg(db: Queryable, c: NewCounter): Promise<{ id: string; round: number } | undefined> {
  const r = await lostRace(db.query(
    `WITH target AS (
       SELECT o.id, o.status AS from_status FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
       WHERE o.id = $1 AND o.buyer_user_id = $3 AND o.status = 'countered' AND l.status = $2
         AND (SELECT count(*) FROM offer_counter x WHERE x.offer_id = o.id) < $10
         AND NOT EXISTS (SELECT 1 FROM offer_counter x WHERE x.offer_id = o.id AND x.status = 'open' AND x.expires_at <= $8)
       FOR UPDATE OF o
     ), closed AS (
       UPDATE offer_counter x SET status = 'countered', closed_at = $8
       FROM target t WHERE x.offer_id = t.id AND x.status = 'open' AND x.from_party = 'owner'
       RETURNING x.id
     ), moved AS (
       UPDATE formal_offer o SET status = 'buyer_countered' FROM target t WHERE o.id = t.id RETURNING o.id
     )${INSERT_COUNTER("buyer")}`,
    [c.offerId, "published", c.userId, c.priceCents, JSON.stringify(c.conditions), c.settlementDays, c.depositCents, c.now, c.expiresAt,
      MAX_COUNTER_ROUNDS]
  ));
  const row = r?.rows[0];
  return row ? { id: String(row["id"]), round: Number(row["round"]) } : undefined;
}

/**
 * The buyer agrees to the owner's open counter (named by id, so they agree to the terms they saw). This does not accept the
 * offer: it hands it back to the owner, who accepts or not.
 */
export async function buyerAgreePg(db: Queryable, offerId: string, buyerUserId: string, counterId: string, now: string): Promise<boolean> {
  const r = await db.query(
    `WITH target AS (
       SELECT o.id, o.status AS from_status FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
       WHERE o.id = $1 AND o.buyer_user_id = $2 AND o.status = 'countered' AND l.status = 'published'
       FOR UPDATE OF o
     ), agreed AS (
       UPDATE offer_counter x SET status = 'agreed', closed_at = $4
       FROM target t WHERE x.offer_id = t.id AND x.id = $3 AND x.status = 'open' AND x.from_party = 'owner' AND x.expires_at > $4
       RETURNING x.offer_id, x.id, x.round, x.price_cents, x.conditions, x.settlement_days, x.deposit_cents
     ), moved AS (
       UPDATE formal_offer o SET status = 'buyer_countered' FROM agreed a WHERE o.id = a.offer_id RETURNING o.id
     )
     INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, counter_id, counter_round,
       price_cents, conditions, settlement_days, deposit_cents, from_status, to_status, occurred_at)
     SELECT m.id, 'buyer_agreed', 'buyer', $2, a.id, a.round, a.price_cents, a.conditions, a.settlement_days, a.deposit_cents,
       t.from_status, 'buyer_countered', $4
     FROM moved m JOIN agreed a ON a.offer_id = m.id JOIN target t ON t.id = m.id
     RETURNING offer_id AS id`,
    [offerId, buyerUserId, counterId, now]
  );
  return r.rows.length === 1;
}

/** The buyer withdraws before acceptance. Any open counter closes as withdrawn. */
export async function buyerWithdrawPg(db: Queryable, offerId: string, buyerUserId: string, from: readonly string[], now: string): Promise<boolean> {
  const r = await db.query(
    `WITH target AS (
       SELECT o.id, o.status AS from_status FROM formal_offer o WHERE o.id = $1 AND o.buyer_user_id = $2 AND o.status = ANY($3::text[]) FOR UPDATE
     ), closed AS (
       UPDATE offer_counter x SET status = 'withdrawn', closed_at = $4 FROM target t WHERE x.offer_id = t.id AND x.status = 'open'
       RETURNING x.id
     ), moved AS (
       UPDATE formal_offer o SET status = 'withdrawn' FROM target t WHERE o.id = t.id RETURNING o.id
     )
     INSERT INTO offer_event (offer_id, event_type, actor_kind, actor_user_id, from_status, to_status, occurred_at)
     SELECT m.id, 'withdrawn', 'buyer', $2, t.from_status, 'withdrawn', $4 FROM moved m JOIN target t ON t.id = m.id
     RETURNING offer_id AS id`,
    [offerId, buyerUserId, [...from], now]
  );
  return r.rows.length === 1;
}

/** Every counter on an offer, oldest first. No user ids: each side sees only "owner" or "buyer". */
export async function countersForOfferPg(db: Queryable, offerId: string): Promise<CounterView[]> {
  const { rows } = await db.query(
    `SELECT id, round, from_party, price_cents, conditions, settlement_days, deposit_cents, status, created_at, expires_at, closed_at
     FROM offer_counter WHERE offer_id = $1 ORDER BY round`,
    [offerId]
  );
  return rows.map(r => ({
    id: String(r["id"]),
    round: Number(r["round"]),
    fromParty: r["from_party"] === "owner" ? "owner" : "buyer",
    priceCents: Number(r["price_cents"]),
    conditions: strings(r["conditions"]),
    settlementDays: Number(r["settlement_days"]),
    depositCents: Number(r["deposit_cents"]),
    status: String(r["status"]),
    createdAt: iso(r["created_at"] as Date | string),
    expiresAt: iso(r["expires_at"] as Date | string),
    ...(r["closed_at"] ? { closedAt: iso(r["closed_at"] as Date | string) } : {})
  }));
}

/** What the buyer sees about their own offer. Nothing about the owner beyond the listing's public title. */
export interface BuyerOfferView extends CounterTerms {
  id: string;
  listingId: string;
  listingTitle: string;
  status: string;
  submittedAt: string;
}

/** The buyer's own offers (original terms), newest first. The buyer check is part of the query. */
export async function offersForBuyerPg(db: Queryable, buyerUserId: string, offerId?: string): Promise<BuyerOfferView[]> {
  const { rows } = await db.query(
    `SELECT o.id, o.listing_id, l.title, o.price_cents, o.conditions, o.settlement_days, o.deposit_cents, o.status, o.submitted_at
     FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id
     WHERE o.buyer_user_id = $1 AND ($2::uuid IS NULL OR o.id = $2)
     ORDER BY o.submitted_at DESC LIMIT 200`,
    [buyerUserId, offerId ?? null]
  );
  return rows.map(r => ({
    id: String(r["id"]),
    listingId: String(r["listing_id"]),
    listingTitle: String(r["title"]),
    priceCents: Number(r["price_cents"]),
    conditions: strings(r["conditions"]),
    settlementDays: Number(r["settlement_days"]),
    depositCents: Number(r["deposit_cents"]),
    status: String(r["status"]),
    submittedAt: iso(r["submitted_at"] as Date | string)
  }));
}

