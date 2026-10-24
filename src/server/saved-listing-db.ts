import type { SavedListingRepository, SavedListingView } from "../domain/saved-listings";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/** Every query is parameterised and scoped to one buyer's user id. */
export function createPgSavedListingRepository(db: Queryable): SavedListingRepository {
  return {
    async list(buyerUserId) {
      const r = await db.query(
        `SELECT l.id, l.title, l.suburb, l.price_cents, l.bedrooms, l.transaction_type, s.created_at
           FROM saved_listing s JOIN property_listing l ON l.id = s.listing_id
          WHERE s.buyer_user_id = $1 AND l.status = 'published'
          ORDER BY s.created_at DESC LIMIT 200`, [buyerUserId]);
      return r.rows.map((row): SavedListingView => ({
        listingId: String(row["id"]), title: String(row["title"]),
        transactionType: row["transaction_type"] === "rent" ? "rent" : "sale", savedAt: iso(row["created_at"]),
        ...(typeof row["suburb"] === "string" ? { suburb: row["suburb"] } : {}),
        ...(row["price_cents"] != null ? { priceCents: Number(row["price_cents"]) } : {}),
        ...(row["bedrooms"] != null ? { bedrooms: Number(row["bedrooms"]) } : {})
      }));
    },
    async add(buyerUserId, listingId) {
      const r = await db.query(
        `INSERT INTO saved_listing (buyer_user_id, listing_id)
         SELECT $1, id FROM property_listing WHERE id = $2 AND status = 'published'
         ON CONFLICT (buyer_user_id, listing_id) DO NOTHING RETURNING listing_id`, [buyerUserId, listingId]);
      if (r.rows.length > 0) return true;
      const ex = await db.query(
        "SELECT 1 FROM saved_listing s JOIN property_listing l ON l.id = s.listing_id WHERE s.buyer_user_id = $1 AND s.listing_id = $2 AND l.status = 'published'",
        [buyerUserId, listingId]);
      return ex.rows.length > 0;
    },
    async remove(buyerUserId, listingId) {
      await db.query("DELETE FROM saved_listing WHERE buyer_user_id = $1 AND listing_id = $2", [buyerUserId, listingId]);
    },
    async count(buyerUserId) {
      const r = await db.query("SELECT count(*) AS n FROM saved_listing WHERE buyer_user_id = $1", [buyerUserId]);
      return Number(r.rows[0]?.["n"] ?? 0);
    }
  };
}
