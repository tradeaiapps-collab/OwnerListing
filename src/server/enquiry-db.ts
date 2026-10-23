import type { BuyerVerification } from "../domain/buyer";
import type { Enquiry, EnquiryMessage, EnquiryRepository } from "../domain/enquiry-service";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const toEnquiry = (r: Record<string, unknown>): Enquiry => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), buyerUserId: String(r["buyer_user_id"]), createdAt: iso(r["created_at"])
});

/** PostgreSQL enquiry store. Messages can only be inserted; the database rejects edits and deletes. */
export function createPgEnquiryRepository(db: Queryable): EnquiryRepository {
  return {
    async find(listingId, buyerUserId) {
      const r = await db.query("SELECT * FROM enquiry WHERE listing_id = $1 AND buyer_user_id = $2", [listingId, buyerUserId]);
      return r.rows[0] ? toEnquiry(r.rows[0]) : undefined;
    },
    async get(id) {
      const r = await db.query("SELECT * FROM enquiry WHERE id = $1", [id]);
      return r.rows[0] ? toEnquiry(r.rows[0]) : undefined;
    },
    async insert(e) {
      await db.query("INSERT INTO enquiry (id, listing_id, buyer_user_id, created_at) VALUES ($1,$2,$3,$4)", [e.id, e.listingId, e.buyerUserId, e.createdAt]);
    },
    async listByBuyer(buyerUserId) {
      const r = await db.query("SELECT * FROM enquiry WHERE buyer_user_id = $1 ORDER BY created_at DESC", [buyerUserId]);
      return r.rows.map(toEnquiry);
    },
    async listByListings(listingIds) {
      if (listingIds.length === 0) return [];
      const r = await db.query("SELECT * FROM enquiry WHERE listing_id = ANY($1::uuid[]) ORDER BY created_at DESC", [[...listingIds]]);
      return r.rows.map(toEnquiry);
    },
    async addMessage(m) {
      await db.query("INSERT INTO enquiry_message (id, enquiry_id, sender_user_id, body, sent_at) VALUES ($1,$2,$3,$4,$5)", [m.id, m.enquiryId, m.senderUserId, m.body, m.sentAt]);
    },
    async messages(enquiryId) {
      const r = await db.query("SELECT * FROM enquiry_message WHERE enquiry_id = $1 ORDER BY sent_at, id", [enquiryId]);
      return r.rows.map((x): EnquiryMessage => ({
        id: String(x["id"]), enquiryId: String(x["enquiry_id"]), senderUserId: String(x["sender_user_id"]),
        body: String(x["body"]), sentAt: iso(x["sent_at"])
      }));
    }
  };
}

/** Missing row means not verified at all. */
export async function getBuyerVerification(db: Queryable, userId: string): Promise<BuyerVerification> {
  const r = await db.query("SELECT email_verified_at, phone_verified_at, id_verified_at FROM buyer_verification WHERE user_id = $1", [userId]);
  const row = r.rows[0];
  return {
    emailVerified: Boolean(row?.["email_verified_at"]),
    phoneVerified: Boolean(row?.["phone_verified_at"]),
    idVerified: Boolean(row?.["id_verified_at"])
  };
}
