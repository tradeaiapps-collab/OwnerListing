import type { IdImageMime, IdImagePart } from "../domain/id-image";
import { windowStart } from "../domain/rate-limit";
import type { Queryable } from "./db";
import type { IdImageStore, ReviewState } from "./id-image";
import { countHitPg } from "./offer-flow-db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const COL: Record<IdImagePart, { key: string; sha: string; mime: string }> = {
  front: { key: "front_image_key", sha: "front_sha256", mime: "front_mime" },
  back: { key: "back_image_key", sha: "back_sha256", mime: "back_mime" },
  selfie: { key: "selfie_key", sha: "selfie_sha256", mime: "selfie_mime" }
};

/** Postgres store for ID images. Every statement is constant text with bound parameters (column names come from COL only). */
export function createPgIdImageStore(db: Queryable): IdImageStore {
  return {
    hit: (bucket, windowMs) => countHitPg(db, bucket, windowStart(new Date().toISOString(), windowMs)),
    async buyerState(userId) {
      const v = await db.query(
        "SELECT email_verified_at IS NOT NULL AS e, phone_verified_at IS NOT NULL AS p, id_verified_at IS NOT NULL AS i FROM buyer_verification WHERE user_id = $1::uuid",
        [userId]);
      const s = await db.query(
        "SELECT status, submitted_at FROM id_submission WHERE user_id = $1::uuid AND (status = 'pending' OR submitted_at > now() - interval '1 day')",
        [userId]);
      const r = v.rows[0];
      return {
        emailVerified: r?.["e"] === true, phoneVerified: r?.["p"] === true, idVerified: r?.["i"] === true,
        pending: s.rows.some(x => x["status"] === "pending"), recentSubmittedAt: s.rows.map(x => iso(x["submitted_at"]))
      };
    },
    async recordConsent(userId, version) {
      await db.query("INSERT INTO id_image_consent (user_id, wording_version) VALUES ($1::uuid, $2)", [userId, version]);
    },
    async latestStatus(userId) {
      const r = await db.query("SELECT status FROM id_submission WHERE user_id = $1::uuid ORDER BY submitted_at DESC LIMIT 1", [userId]);
      const v = r.rows[0]?.["status"];
      return typeof v === "string" ? v : null;
    },
    async insertSubmission(s) {
      const i = s.images;
      const r = await db.query(
        `INSERT INTO id_submission (id, user_id, document_kind, document_country, expiry_date, selfie_captured_in_app, consent_version,
            front_image_key, front_sha256, front_mime, back_image_key, back_sha256, back_mime, selfie_key, selfie_sha256, selfie_mime)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
        [s.id, s.userId, s.documentKind, s.documentCountry, s.expiryDate, s.selfieCapturedInApp, s.consentVersion,
          i.front?.key ?? null, i.front?.sha256 ?? null, i.front?.mime ?? null, i.back?.key ?? null, i.back?.sha256 ?? null, i.back?.mime ?? null,
          i.selfie?.key ?? null, i.selfie?.sha256 ?? null, i.selfie?.mime ?? null]);
      return r.rows.length === 1;
    },
    async log(e) {
      await db.query(
        "INSERT INTO id_submission_log (event, user_id, submission_id, staff_user_id, ip_hash) VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5)",
        [e.event, e.userId ?? null, e.submissionId ?? null, e.staffId ?? null, e.ipHash ?? null]);
    },
    async reviewState(id): Promise<ReviewState | null> {
      const r = (await db.query(
        `SELECT user_id, status, approvals, assigned_reviewer, assigned_at, images_deleted_at IS NOT NULL AS deleted,
                front_image_key IS NOT NULL AS f, back_image_key IS NOT NULL AS b, selfie_key IS NOT NULL AS s
           FROM id_submission WHERE id = $1::uuid`, [id])).rows[0];
      if (!r) return null;
      return {
        userId: String(r["user_id"]), status: String(r["status"]),
        approvals: Array.isArray(r["approvals"]) ? (r["approvals"] as string[]) : [],
        assignedTo: (r["assigned_reviewer"] as string | null) ?? null, assignedAt: r["assigned_at"] ? iso(r["assigned_at"]) : null,
        deleted: r["deleted"] === true,
        parts: (["front", "back", "selfie"] as const).filter((_, n) => r[["f", "b", "s"][n]!] === true)
      };
    },
    async claim(id, staffId, ttlMs) {
      const r = await db.query(
        `UPDATE id_submission SET assigned_reviewer = $2::uuid, assigned_at = now()
          WHERE id = $1::uuid AND status = 'pending' AND user_id <> $2::uuid AND NOT (approvals ? $2::text)
            AND (assigned_reviewer IS NULL OR assigned_reviewer = $2::uuid OR assigned_at < now() - $3::int * interval '1 millisecond')
          RETURNING id`, [id, staffId, ttlMs]);
      return r.rows.length === 1;
    },
    async image(id, part) {
      const c = COL[part];
      const r = (await db.query(`SELECT ${c.key} AS k, ${c.sha} AS h, ${c.mime} AS m FROM id_submission WHERE id = $1::uuid AND images_deleted_at IS NULL`, [id])).rows[0];
      if (!r || typeof r["k"] !== "string" || typeof r["h"] !== "string" || typeof r["m"] !== "string") return null;
      return { key: r["k"], sha256: r["h"].trim(), mime: r["m"] as IdImageMime };
    },
    async recordView(id, staffId, part, stage) {
      await db.query("INSERT INTO id_review_access (submission_id, staff_user_id, purpose) VALUES ($1::uuid, $2::uuid, $3)", [id, staffId, `${stage}:${part}`]);
    },
    async viewedParts(id, staffId, since) {
      const r = await db.query(
        "SELECT DISTINCT purpose FROM id_review_access WHERE submission_id = $1::uuid AND staff_user_id = $2::uuid AND viewed_at >= $3::timestamptz AND purpose LIKE 'shown:%'",
        [id, staffId, since]);
      return r.rows.map(x => String(x["purpose"]).replace(/^shown:/, "")).filter((p): p is IdImagePart => p === "front" || p === "back" || p === "selfie");
    },
    async dueForDeletion(approvedBefore, rejectedBefore, limit) {
      const r = await db.query(
        `SELECT id, user_id, front_image_key, back_image_key, selfie_key FROM id_submission
          WHERE images_deleted_at IS NULL AND decided_at IS NOT NULL
            AND ((status = 'approved' AND decided_at <= $1::timestamptz) OR (status IN ('rejected','needs_more') AND decided_at <= $2::timestamptz))
          ORDER BY decided_at LIMIT $3`, [approvedBefore, rejectedBefore, limit]);
      return r.rows.map(x => ({
        id: String(x["id"]), userId: String(x["user_id"]),
        keys: [x["front_image_key"], x["back_image_key"], x["selfie_key"]].filter((k): k is string => typeof k === "string")
      }));
    },
    async markDeleted(id) {
      const r = await db.query(
        `WITH upd AS (UPDATE id_submission SET front_image_key = NULL, back_image_key = NULL, selfie_key = NULL,
                         front_sha256 = NULL, back_sha256 = NULL, selfie_sha256 = NULL, images_deleted_at = now()
                       WHERE id = $1::uuid AND images_deleted_at IS NULL RETURNING id, user_id)
         INSERT INTO id_submission_log (user_id, submission_id, event) SELECT user_id, id, 'images_deleted' FROM upd RETURNING submission_id`, [id]);
      return r.rows.length === 1;
    }
  };
}
