import type { BuyerVerification } from "../domain/buyer";
import type { Enquiry, EnquiryMessage, EnquiryRepository, NotificationRepository } from "../domain/enquiry-service";
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
      await db.query("INSERT INTO enquiry_message (id, enquiry_id, sender_user_id, automated, body, sent_at) VALUES ($1,$2,$3,$4,$5,$6)", [m.id, m.enquiryId, m.senderUserId, m.automated, m.body, m.sentAt]);
    },
    async messages(enquiryId) {
      const r = await db.query("SELECT * FROM enquiry_message WHERE enquiry_id = $1 ORDER BY sent_at, id", [enquiryId]);
      return r.rows.map((x): EnquiryMessage => ({
        id: String(x["id"]), enquiryId: String(x["enquiry_id"]),
        senderUserId: x["sender_user_id"] === null ? null : String(x["sender_user_id"]), automated: x["automated"] === true,
        body: String(x["body"]), sentAt: iso(x["sent_at"])
      }));
    },
    async countSentSince(senderUserId, sinceIso) {
      const r = await db.query("SELECT count(*) AS n FROM enquiry_message WHERE sender_user_id = $1 AND NOT automated AND sent_at >= $2", [senderUserId, sinceIso]);
      return Number(r.rows[0]?.["n"] ?? 0);
    },
    async countStartedSince(buyerUserId, sinceIso) {
      const r = await db.query("SELECT count(*) AS n FROM enquiry WHERE buyer_user_id = $1 AND created_at >= $2", [buyerUserId, sinceIso]);
      return Number(r.rows[0]?.["n"] ?? 0);
    }
  };
}

export function createPgNotificationRepository(db: Queryable): NotificationRepository {
  return {
    async notifyMessage(userId, enquiryId, at) {
      await db.query(
        "INSERT INTO notification (user_id, kind, enquiry_id, created_at) VALUES ($1,'enquiry_message',$2,$3) ON CONFLICT DO NOTHING",
        [userId, enquiryId, at]
      );
    },
    async markRead(userId, enquiryId, at) {
      await db.query("UPDATE notification SET read_at = $3 WHERE user_id = $1 AND enquiry_id = $2 AND read_at IS NULL", [userId, enquiryId, at]);
    },
    async unreadEnquiryIds(userId) {
      const r = await db.query("SELECT enquiry_id FROM notification WHERE user_id = $1 AND read_at IS NULL", [userId]);
      return r.rows.map(x => String(x["enquiry_id"]));
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
