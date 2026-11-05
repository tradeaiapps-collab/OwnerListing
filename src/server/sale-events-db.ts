import type { SaleEventType } from "../domain/sale-events";
import type { ManualSaleEvent } from "../domain/sale-events";
import { maskName } from "../domain/sale-events";
import { decodeCursor, encodeCursor } from "../domain/pagination";
import type { Queryable } from "./db";

/**
 * Sold and rented events (property_event rows of those types). An accepted offer writes one; staff can add historical ones and void
 * wrong ones. Market intelligence reads them through createPlatformComparablesSource. Parameterised SQL only.
 */

const PAGE = 50;
const inTx = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>) => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Finds or creates the property record behind a listing (same address and state means the same property, so a relisting joins its
 * history) and links the listing to it. Returns the property id, or undefined when the listing does not exist.
 */
export async function ensurePropertyForListingPg(db: Queryable, listingId: string): Promise<string | undefined> {
  return inTx(db, async tx => {
    const l = (await tx.query("SELECT property_id FROM property_listing WHERE id = $1::uuid FOR UPDATE", [listingId])).rows[0];
    if (!l) return undefined;
    if (l["property_id"]) return String(l["property_id"]);
    const found = await tx.query(
      `SELECT p.id FROM property p, property_listing l WHERE l.id = $1::uuid AND p.state = l.jurisdiction AND lower(p.address_text) = lower(l.address_text) ORDER BY p.created_at LIMIT 1`,
      [listingId]
    );
    let pid = found.rows[0]?.["id"] as string | undefined;
    if (!pid) {
      const made = await tx.query(
        `INSERT INTO property (address_text, state, suburb, postcode, use_class, property_type, bedrooms, bathrooms, car_spaces, latitude, longitude)
         SELECT address_text, jurisdiction, suburb, postcode, use_class, property_type, bedrooms, bathrooms, parking, latitude, longitude FROM property_listing WHERE id = $1::uuid RETURNING id`,
        [listingId]
      );
      pid = String(made.rows[0]!["id"]);
    }
    await tx.query("UPDATE property_listing SET property_id = $2::uuid WHERE id = $1::uuid AND property_id IS NULL", [listingId, pid]);
    return String(pid);
  });
}

/**
 * Writes the sold or rented event for an accepted offer: price and date are those of the acceptance (the accepted terms on the
 * offer timeline), the agent is the listing's active appointment, the buyer is the offer's buyer. Safe to call again: one event per
 * offer, and a voided one stays voided. Returns true when it wrote a row.
 */
export async function recordAcceptedOfferEventPg(db: Queryable, offerId: string): Promise<boolean> {
  const o = (await db.query("SELECT listing_id FROM formal_offer WHERE id = $1::uuid AND status = 'accepted'", [offerId])).rows[0];
  if (!o) return false;
  if (!(await ensurePropertyForListingPg(db, String(o["listing_id"])))) return false;
  const r = await db.query(
    `INSERT INTO property_event (property_id, listing_id, event_type, occurred_at, amount_cents, source, details, offer_id, agent_user_id, buyer_user_id, origin)
     SELECT l.property_id, l.id, CASE l.transaction_type WHEN 'rent' THEN 'rented' ELSE 'sold' END,
            COALESCE(ev.occurred_at, o.submitted_at), COALESCE(ev.price_cents, o.price_cents), 'platform',
            jsonb_build_object('settlementDays', COALESCE(ev.settlement_days, o.settlement_days), 'depositCents', COALESCE(ev.deposit_cents, o.deposit_cents)),
            o.id, ag.agent_user_id, o.buyer_user_id, 'accepted_offer'
       FROM formal_offer o
       JOIN property_listing l ON l.id = o.listing_id
       LEFT JOIN LATERAL (SELECT e.occurred_at, e.price_cents, e.settlement_days, e.deposit_cents FROM offer_event e
                           WHERE e.offer_id = o.id AND e.event_type = 'accepted' ORDER BY e.occurred_at DESC LIMIT 1) ev ON true
       LEFT JOIN listing_agent_appointment ag ON ag.listing_id = l.id AND ag.revoked_at IS NULL
      WHERE o.id = $1::uuid AND o.status = 'accepted' AND l.property_id IS NOT NULL
     ON CONFLICT (offer_id) WHERE offer_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [offerId]
  );
  return r.rows.length === 1;
}

/** Accepted offers that have no event yet (accepted before this existed, or a write that failed). Writes them; returns how many. */
export async function backfillAcceptedOfferEventsPg(db: Queryable, limit = 500): Promise<{ checked: number; written: number }> {
  const r = await db.query(
    `SELECT o.id FROM formal_offer o WHERE o.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM property_event e WHERE e.offer_id = o.id) ORDER BY o.submitted_at LIMIT $1::int`,
    [limit]
  );
  let written = 0;
  for (const row of r.rows) if (await recordAcceptedOfferEventPg(db, String(row["id"]))) written++;
  return { checked: r.rows.length, written };
}

/** A staff-entered historical sale or rental. Finds or creates the property by address and state. Returns the new event id. */
export async function recordManualEventPg(db: Queryable, e: ManualSaleEvent, staffId: string): Promise<string> {
  return inTx(db, async tx => {
    const found = await tx.query("SELECT id FROM property WHERE state = $1 AND lower(address_text) = lower($2) ORDER BY created_at LIMIT 1", [e.state, e.address]);
    let pid = found.rows[0]?.["id"] as string | undefined;
    if (!pid) {
      pid = String((await tx.query(
        `INSERT INTO property (address_text, state, suburb, postcode, use_class, property_type, bedrooms, bathrooms, car_spaces, land_area_sqm)
         VALUES ($1,$2,$3,$4,'residential',$5,$6,$7,$8,$9) RETURNING id`,
        [e.address, e.state, e.suburb, e.postcode, e.propertyType, e.bedrooms ?? null, e.bathrooms ?? null, e.carSpaces ?? null, e.landAreaSqm ?? null]
      )).rows[0]!["id"]);
    }
    const r = await tx.query(
      `INSERT INTO property_event (property_id, event_type, occurred_at, amount_cents, source, origin, recorded_by, counterparty_label, note)
       VALUES ($1::uuid,$2,$3::timestamptz,$4,$5,'staff_manual',$6,$7,$8) RETURNING id`,
      [pid, e.eventType, e.occurredAt, e.amountCents, e.source, staffId, e.counterparty ?? null, e.note ?? null]
    );
    return String(r.rows[0]!["id"]);
  });
}

export type VoidOutcome = { outcome: "voided"; propertyId: string } | { outcome: "not_found" } | { outcome: "already_voided" };

/** Takes a sold or rented event out of valuations, with a reason. The row stays for the audit trail. */
export async function voidSaleEventPg(db: Queryable, eventId: string, staffId: string, reason: string, now: string): Promise<VoidOutcome> {
  const r = await db.query(
    `UPDATE property_event SET voided_at = $4::timestamptz, voided_by = $2, void_reason = $3
      WHERE id = $1::uuid AND event_type IN ('sold','rented') AND voided_at IS NULL RETURNING property_id`,
    [eventId, staffId, reason, now]
  );
  if (r.rows[0]) return { outcome: "voided", propertyId: String(r.rows[0]["property_id"]) };
  const e = await db.query("SELECT voided_at FROM property_event WHERE id = $1::uuid AND event_type IN ('sold','rented')", [eventId]);
  return { outcome: e.rows[0] ? "already_voided" : "not_found" };
}

export interface SaleEventFilters { type?: SaleEventType; status?: "active" | "voided" | "all"; origin?: "accepted_offer" | "staff_manual"; q?: string; cursor?: string }
export interface SaleEventRow {
  id: string; eventType: SaleEventType; occurredAt: string; amountCents: number; source: string; origin: string | null;
  property: { id: string; address: string; suburb: string | null; postcode: string | null; state: string; propertyType: string | null };
  listingId: string | null; offerId: string | null;
  agent: { id: string; name: string | null } | null; buyer: { id: string; name: string | null } | null; counterparty: string | null;
  recordedBy: string | null; note: string | null;
  voided: { at: string; by: string | null; reason: string | null } | null;
}

/** The sold and rented log, newest first, filtered and paged. Names are masked unless `fullNames` (staff holding pii.view_full). */
export async function listSaleEventsPg(db: Queryable, f: SaleEventFilters, fullNames: boolean): Promise<{ rows: SaleEventRow[]; nextCursor: string | null }> {
  const cur = f.cursor ? decodeCursor(f.cursor) : null;
  const q = f.q ? `%${f.q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
  const res = await db.query(
    `SELECT e.id, e.event_type, e.occurred_at, e.amount_cents, e.source, e.origin, e.listing_id, e.offer_id, e.recorded_by, e.note, e.counterparty_label,
            e.voided_at, e.voided_by, e.void_reason, e.agent_user_id, e.buyer_user_id, ag.display_name AS agent_name, bu.display_name AS buyer_name,
            p.id AS property_id, p.address_text, p.suburb, p.postcode, p.state, p.property_type
       FROM property_event e JOIN property p ON p.id = e.property_id
       LEFT JOIN app_user ag ON ag.id = e.agent_user_id LEFT JOIN app_user bu ON bu.id = e.buyer_user_id
      WHERE e.event_type IN ('sold','rented')
        AND ($1::text IS NULL OR e.event_type = $1) AND ($2::text IS NULL OR e.origin = $2)
        AND ($3::text = 'all' OR ($3::text = 'voided') = (e.voided_at IS NOT NULL))
        AND ($4::text IS NULL OR p.address_text ILIKE $4 ESCAPE '\\' OR p.suburb ILIKE $4 ESCAPE '\\' OR p.postcode = $5 OR e.id::text = $5 OR e.offer_id::text = $5)
        AND ($6::timestamptz IS NULL OR (e.occurred_at, e.id) < ($6::timestamptz, $7::uuid))
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${PAGE + 1}`,
    [f.type ?? null, f.origin ?? null, f.status ?? "active", q, f.q ?? null, cur?.sortValue ?? null, cur?.id ?? null]
  );
  const rows = res.rows.slice(0, PAGE).map((x): SaleEventRow => {
    const nm = (v: unknown) => (typeof v === "string" ? (fullNames ? v : maskName(v)) : null);
    return {
      id: String(x["id"]), eventType: x["event_type"] as SaleEventType, occurredAt: iso(x["occurred_at"]), amountCents: Number(x["amount_cents"]),
      source: String(x["source"]), origin: (x["origin"] as string | null) ?? null,
      property: { id: String(x["property_id"]), address: String(x["address_text"]), suburb: (x["suburb"] as string | null) ?? null, postcode: x["postcode"] ? String(x["postcode"]).trim() : null, state: String(x["state"]).trim(), propertyType: (x["property_type"] as string | null) ?? null },
      listingId: x["listing_id"] ? String(x["listing_id"]) : null, offerId: x["offer_id"] ? String(x["offer_id"]) : null,
      agent: x["agent_user_id"] ? { id: String(x["agent_user_id"]), name: nm(x["agent_name"]) } : null,
      buyer: x["buyer_user_id"] ? { id: String(x["buyer_user_id"]), name: nm(x["buyer_name"]) } : null,
      counterparty: nm(x["counterparty_label"]), recordedBy: (x["recorded_by"] as string | null) ?? null, note: (x["note"] as string | null) ?? null,
      voided: x["voided_at"] ? { at: iso(x["voided_at"]), by: (x["voided_by"] as string | null) ?? null, reason: (x["void_reason"] as string | null) ?? null } : null
    } as SaleEventRow;
  });
  const last = res.rows.length > PAGE ? rows[rows.length - 1] : undefined;
  return { rows, nextCursor: last ? encodeCursor({ sortValue: last.occurredAt, id: last.id }) : null };
}
