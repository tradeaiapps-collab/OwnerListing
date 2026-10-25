import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/**
 * The other offers by the same buyer on the same listing (amount, date, status), excluding this one. The buyer id is used only
 * inside the query and never returned, so the owner's screen still has no buyer identity.
 */
export async function sameBuyerOffersPg(db: Queryable, listingId: string, offerId: string): Promise<{ priceCents: number; submittedAt: string; status: string }[]> {
  const r = await db.query(
    `SELECT o.price_cents, o.submitted_at, o.status FROM formal_offer o
     JOIN formal_offer me ON me.id = $2::uuid AND me.listing_id = $1::uuid
     WHERE o.listing_id = $1::uuid AND o.buyer_user_id = me.buyer_user_id AND o.id <> me.id
     ORDER BY o.submitted_at LIMIT 50`,
    [listingId, offerId]
  );
  return r.rows.map(x => ({ priceCents: Number(x["price_cents"]), submittedAt: iso(x["submitted_at"]), status: String(x["status"]) }));
}

/** The buyer's enquiry thread on this listing, if they have one, so an offer response can be sent there. */
export async function enquiryForOfferPg(db: Queryable, listingId: string, offerId: string): Promise<string | undefined> {
  const r = await db.query(
    `SELECT e.id FROM enquiry e JOIN formal_offer o ON o.buyer_user_id = e.buyer_user_id AND o.listing_id = e.listing_id
     WHERE o.id = $2::uuid AND o.listing_id = $1::uuid`,
    [listingId, offerId]
  );
  return r.rows[0] ? String(r.rows[0]["id"]) : undefined;
}
