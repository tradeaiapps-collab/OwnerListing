import { guardContent } from "./content-guard";
import { createPgContentFlagStore } from "./content-flag-db";
import { randomUUID } from "node:crypto";
import type { AutoReplySettings } from "../domain/auto-reply";
import type { BuyerVerification } from "../domain/buyer";
import type { DraftRepository, DraftStatus, ReplyDraft } from "../domain/enquiry-drafts";
import type { Enquiry, EnquiryDeps, EnquiryMessage, EnquiryRepository } from "../domain/enquiry-service";
import { hashToken } from "../domain/offer-intake";
import { openOfferToken, sealOfferToken } from "../domain/offer-link-crypto";
import { windowStart } from "../domain/rate-limit";
import type { OfferLinkDeps, OfferLinkRequest, OfferLinkRequestRepository, OfferLinkRequestStatus } from "../domain/offer-link-request";
import { getDb, getDeps } from "./context";
import type { Queryable } from "./db";
import { countHitPg, eligibleBuyerPg } from "./offer-flow-db";
import { hasCurrentTermsPg } from "./terms-db";

// Every statement has constant text; user input only ever travels as a bound parameter.
// There is no UPDATE or DELETE on enquiry_message anywhere: it is an append-only record (db trigger too).
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const toEnquiry = (r: Record<string, unknown>): Enquiry => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), buyerUserId: String(r["buyer_user_id"]), createdAt: iso(r["created_at"])
});
const toDraft = (r: Record<string, unknown>): ReplyDraft => ({
  id: String(r["id"]), enquiryId: String(r["enquiry_id"]), templateId: String(r["template_id"]), body: String(r["body"]),
  reviewUntil: iso(r["review_until"]), status: String(r["status"]) as DraftStatus, createdAt: iso(r["created_at"])
});

export function createPgEnquiryRepository(db: Queryable): EnquiryRepository {
  return {
    async find(listingId, buyerUserId) {
      const r = await db.query("SELECT * FROM enquiry WHERE listing_id = $1::uuid AND buyer_user_id = $2::uuid", [listingId, buyerUserId]);
      return r.rows[0] ? toEnquiry(r.rows[0]) : undefined;
    },
    async get(id) {
      const r = await db.query("SELECT * FROM enquiry WHERE id = $1::uuid", [id]);
      return r.rows[0] ? toEnquiry(r.rows[0]) : undefined;
    },
    async insert(e) {
      await db.query("INSERT INTO enquiry (id, listing_id, buyer_user_id, created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::timestamptz)", [e.id, e.listingId, e.buyerUserId, e.createdAt]);
    },
    async listByBuyer(buyerUserId) {
      const r = await db.query("SELECT * FROM enquiry WHERE buyer_user_id = $1::uuid ORDER BY created_at DESC", [buyerUserId]);
      return r.rows.map(toEnquiry);
    },
    async listByListings(listingIds) {
      if (listingIds.length === 0) return [];
      const r = await db.query("SELECT * FROM enquiry WHERE listing_id = ANY($1::uuid[]) ORDER BY created_at DESC", [[...listingIds]]);
      return r.rows.map(toEnquiry);
    },
    async addMessage(m) {
      await db.query(
        "INSERT INTO enquiry_message (id, enquiry_id, sender_user_id, automated, body, sent_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::timestamptz)",
        [m.id, m.enquiryId, m.senderUserId, m.automated, m.body, m.sentAt]
      );
    },
    async addNotice(m) {
      // ON CONFLICT DO NOTHING hits enquiry_message_one_notice_per_hour_idx: a racing second notice inserts nothing.
      const r = await db.query(
        `INSERT INTO enquiry_message (id, enquiry_id, sender_user_id, automated, body, sent_at) VALUES ($1::uuid,$2::uuid,NULL,true,$3,$4::timestamptz)
         ON CONFLICT DO NOTHING RETURNING id`,
        [m.id, m.enquiryId, m.body, m.sentAt]
      );
      return r.rows.length === 1;
    },
    async messages(enquiryId) {
      const r = await db.query("SELECT * FROM enquiry_message WHERE enquiry_id = $1::uuid ORDER BY sent_at, id", [enquiryId]);
      return r.rows.map((x): EnquiryMessage => ({
        id: String(x["id"]), enquiryId: String(x["enquiry_id"]), senderUserId: x["sender_user_id"] === null ? null : String(x["sender_user_id"]),
        automated: x["automated"] === true, ...(x["elena"] === true ? { elena: true } : {}), body: String(x["body"]), sentAt: iso(x["sent_at"])
      }));
    },
    async lastAutomatedAt(enquiryId) {
      const r = await db.query("SELECT max(sent_at) AS at FROM enquiry_message WHERE enquiry_id = $1::uuid AND automated", [enquiryId]);
      const at = r.rows[0]?.["at"];
      return at ? iso(at) : undefined;
    },
    async unreadCounts(userId, enquiryIds) {
      const out = new Map<string, number>();
      if (enquiryIds.length === 0) return out;
      const r = await db.query(
        `SELECT m.enquiry_id, count(*) AS n FROM enquiry_message m
         LEFT JOIN enquiry_read rd ON rd.enquiry_id = m.enquiry_id AND rd.user_id = $1::uuid
         WHERE m.enquiry_id = ANY($2::uuid[]) AND m.sender_user_id IS DISTINCT FROM $1::uuid
           AND (rd.last_read_at IS NULL OR m.sent_at > rd.last_read_at)
         GROUP BY m.enquiry_id`,
        [userId, [...enquiryIds]]
      );
      for (const x of r.rows) out.set(String(x["enquiry_id"]), Number(x["n"]));
      return out;
    },
    async markRead(userId, enquiryId, at) {
      await db.query(
        `INSERT INTO enquiry_read (enquiry_id, user_id, last_read_at) VALUES ($1::uuid,$2::uuid,$3::timestamptz)
         ON CONFLICT (enquiry_id, user_id) DO UPDATE SET last_read_at = GREATEST(enquiry_read.last_read_at, EXCLUDED.last_read_at)`,
        [enquiryId, userId, at]
      );
    },
    async lastReadByOthers(userId, enquiryId) {
      const r = await db.query("SELECT max(last_read_at) AS at FROM enquiry_read WHERE enquiry_id = $1::uuid AND user_id <> $2::uuid", [enquiryId, userId]);
      const at = r.rows[0]?.["at"];
      return at ? iso(at) : undefined;
    }
  };
}

export function createPgDraftRepository(db: Queryable): DraftRepository {
  return {
    async getSettings(ownerUserId) {
      const r = await db.query("SELECT enabled, paused, review_window_minutes FROM auto_reply_setting WHERE owner_user_id = $1::uuid", [ownerUserId]);
      const x = r.rows[0];
      // No row means the owner never turned it on, which is the safe default.
      return x ? { enabled: x["enabled"] === true, paused: x["paused"] === true, reviewWindowMinutes: Number(x["review_window_minutes"]) } : { enabled: false, paused: false, reviewWindowMinutes: 30 };
    },
    async saveSettings(ownerUserId, s: AutoReplySettings) {
      await db.query(
        `INSERT INTO auto_reply_setting (owner_user_id, enabled, paused, review_window_minutes) VALUES ($1::uuid,$2,$3,$4)
         ON CONFLICT (owner_user_id) DO UPDATE SET enabled = EXCLUDED.enabled, paused = EXCLUDED.paused, review_window_minutes = EXCLUDED.review_window_minutes`,
        [ownerUserId, s.enabled, s.paused, s.reviewWindowMinutes]
      );
    },
    async addTemplate(t, approvedAt) {
      await db.query("INSERT INTO enquiry_reply_template (id, owner_user_id, body, approved_at) VALUES ($1::uuid,$2::uuid,$3,$4::timestamptz)", [t.id, t.ownerUserId, t.body, approvedAt]);
    },
    async approvedTemplate(ownerUserId) {
      const r = await db.query("SELECT id, owner_user_id, body FROM enquiry_reply_template WHERE owner_user_id = $1::uuid ORDER BY approved_at, id LIMIT 1", [ownerUserId]);
      const x = r.rows[0];
      return x ? { id: String(x["id"]), ownerUserId: String(x["owner_user_id"]), body: String(x["body"]) } : undefined;
    },
    async insertDraft(d) {
      const r = await db.query(
        `INSERT INTO enquiry_reply_draft (id, enquiry_id, template_id, body, review_until, status, created_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,'queued',$6::timestamptz) ON CONFLICT DO NOTHING RETURNING id`,
        [d.id, d.enquiryId, d.templateId, d.body, d.reviewUntil, d.createdAt]
      );
      return r.rows.length === 1;
    },
    async get(id) {
      const r = await db.query("SELECT * FROM enquiry_reply_draft WHERE id = $1::uuid", [id]);
      return r.rows[0] ? toDraft(r.rows[0]) : undefined;
    },
    async listQueued(ownerUserId) {
      const r = await db.query(
        `SELECT d.* FROM enquiry_reply_draft d JOIN enquiry e ON e.id = d.enquiry_id JOIN property_listing l ON l.id = e.listing_id
         WHERE l.owner_user_id = $1::uuid AND d.status = 'queued' ORDER BY d.created_at, d.id`,
        [ownerUserId]
      );
      return r.rows.map(toDraft);
    },
    async finish(id, to) {
      const r = await db.query("UPDATE enquiry_reply_draft SET status = $2 WHERE id = $1::uuid AND status = 'queued' RETURNING id", [id, to]);
      return r.rows.length === 1;
    }
  };
}

/** Missing row means not verified at all. */
export async function getBuyerVerification(db: Queryable, userId: string): Promise<BuyerVerification> {
  const r = await db.query("SELECT email_verified_at, phone_verified_at, id_verified_at FROM buyer_verification WHERE user_id = $1::uuid", [userId]);
  const row = r.rows[0];
  return {
    emailVerified: Boolean(row?.["email_verified_at"]),
    phoneVerified: Boolean(row?.["phone_verified_at"]),
    idVerified: Boolean(row?.["id_verified_at"])
  };
}

/** Wired from the shared pool in context.ts, so that file stays untouched. */
export function getEnquiryDeps(): EnquiryDeps {
  const db = getDb();
  const base = getDeps();
  return {
    enquiries: createPgEnquiryRepository(db),
    listings: base.repo,
    drafts: createPgDraftRepository(db),
    verification: userId => getBuyerVerification(db, userId),
    countHit: async (key, windowMs) => countHitPg(db, await hashToken(key), windowStart(base.now(), windowMs)),
    offerRequestUrl: enquiryId => `${(process.env["APP_URL"] ?? "").replace(/\/+$/, "")}/enquiries/${enquiryId}`,
    termsCurrentFor: userId => hasCurrentTermsPg(db, userId, base.now()),
    appendAudit: base.appendAudit,
    now: base.now,
    newId: () => randomUUID(),
    contentGuard: ({ userId, enquiryId, text }) =>
      guardContent(createPgContentFlagStore(db), { source: "message", subjectType: "enquiry_message", userId, fields: { body: text } }).then(r => r.ok ? { ok: true as const, after: r.after } : r),
    ...(base.appointmentFor ? { appointmentFor: base.appointmentFor } : {}),
    ...(base.licences ? { licences: base.licences } : {})
  };
}

/** The server key for sealing delivered offer tokens (base64, 32 bytes). Unset means offer links are refused. */
const offerLinkKey = () => process.env["OFFER_LINK_TOKEN_KEY"];

export function createPgOfferLinkRepository(db: Queryable, getKey: () => string | undefined = offerLinkKey): OfferLinkRequestRepository {
  return {
    async open(r) {
      const x = await db.query(
        "INSERT INTO offer_link_request (id, enquiry_id, requested_at) VALUES ($1::uuid,$2::uuid,$3::timestamptz) ON CONFLICT DO NOTHING RETURNING id",
        [r.id, r.enquiryId, r.at]
      );
      return x.rows.length === 1;
    },
    async latest(enquiryId) {
      const x = await db.query(
        "SELECT id, enquiry_id, status, requested_at, decided_at FROM offer_link_request WHERE enquiry_id = $1::uuid ORDER BY requested_at DESC, id DESC LIMIT 1",
        [enquiryId]
      );
      const r = x.rows[0];
      if (!r) return undefined;
      const out: OfferLinkRequest = {
        id: String(r["id"]), enquiryId: String(r["enquiry_id"]), status: String(r["status"]) as OfferLinkRequestStatus, requestedAt: iso(r["requested_at"])
      };
      if (r["decided_at"]) out.decidedAt = iso(r["decided_at"]);
      return out;
    },
    async decline(id, at) {
      const x = await db.query(
        "UPDATE offer_link_request SET status = 'declined', decided_at = $2::timestamptz WHERE id = $1::uuid AND status = 'requested' RETURNING id",
        [id, at]
      );
      return x.rows.length === 1;
    },
    async issue(id, link, token, at) {
      // Sealed before touching the database: with no usable key this throws and nothing is stored.
      const sealed = await sealOfferToken(token, getKey(), id);
      // One statement: the request flips to issued and the hashed link is stored, or neither happens.
      const x = await db.query(
        `WITH r AS (
           UPDATE offer_link_request SET status = 'issued', decided_at = $2::timestamptz, token_hash = $3, link_ciphertext = $7
           WHERE id = $1::uuid AND status = 'requested' RETURNING id
         )
         INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, created_at, expires_at)
         SELECT $3, $4::uuid, $5::uuid, $2::timestamptz, $6::timestamptz FROM r RETURNING token_hash`,
        [id, at, link.tokenHash, link.listingId, link.buyerUserId, link.expiresAt, sealed]
      );
      return x.rows.length === 1;
    },
    async liveLink(enquiryId, now) {
      // Wipe the ciphertext of any link that is used or expired, then read the one that is still live.
      await db.query(
        `UPDATE offer_link_request r SET link_ciphertext = NULL FROM offer_link l
         WHERE r.enquiry_id = $1::uuid AND r.link_ciphertext IS NOT NULL AND l.token_hash = r.token_hash
           AND (l.used_at IS NOT NULL OR l.expires_at <= $2::timestamptz)`,
        [enquiryId, now]
      );
      const x = await db.query(
        `SELECT r.id, r.link_ciphertext, l.listing_id, l.expires_at FROM offer_link_request r JOIN offer_link l ON l.token_hash = r.token_hash
         WHERE r.enquiry_id = $1::uuid AND r.status = 'issued' AND r.link_ciphertext IS NOT NULL AND l.used_at IS NULL AND l.expires_at > $2::timestamptz
         ORDER BY r.requested_at DESC LIMIT 1`,
        [enquiryId, now]
      );
      const r = x.rows[0];
      if (!r) return undefined;
      // Fails closed: no key, wrong key or tampered data all mean the link is not shown.
      const token = await openOfferToken(String(r["link_ciphertext"]), getKey(), String(r["id"])).catch(() => undefined);
      return token === undefined ? undefined : { token, listingId: String(r["listing_id"]), expiresAt: iso(r["expires_at"]) };
    }
  };
}

export function getOfferLinkDeps(): OfferLinkDeps {
  const db = getDb();
  return { ...getEnquiryDeps(), offerLinks: createPgOfferLinkRepository(db), eligibleBuyer: (b, o) => eligibleBuyerPg(db, b, o) };
}
