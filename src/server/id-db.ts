import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileStore, IdRepository } from "../domain/id-review-service";
import type { IdSubmission } from "../domain/id-verification";
import type { StaffActor, StaffRole } from "../domain/staff-access";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const opt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));

function toSubmission(r: Record<string, unknown>): IdSubmission {
  const front = opt(r["front_image_key"]), back = opt(r["back_image_key"]), selfie = opt(r["selfie_key"]), decided = opt(r["decided_at"]);
  return {
    id: String(r["id"]), userId: String(r["user_id"]),
    documentKind: String(r["document_kind"]) as IdSubmission["documentKind"],
    documentCountry: String(r["document_country"]), expiryDate: day(r["expiry_date"]),
    ...(front ? { frontImageRef: front } : {}), ...(back ? { backImageRef: back } : {}), ...(selfie ? { selfieRef: selfie } : {}),
    selfieCapturedInApp: r["selfie_captured_in_app"] === true,
    submittedAt: iso(r["submitted_at"]), status: String(r["status"]) as IdSubmission["status"],
    approvals: Array.isArray(r["approvals"]) ? (r["approvals"] as unknown[]).map(String) : [],
    ...(decided ? { decidedAt: iso(decided) } : {})
  };
}

export function createPgIdRepository(db: Queryable): IdRepository {
  return {
    async insert(s) {
      try {
        await db.query(
          `INSERT INTO id_submission (id, user_id, document_kind, document_country, expiry_date, front_image_key, back_image_key, selfie_key, selfie_captured_in_app, submitted_at, status, approvals)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending','[]'::jsonb)`,
          [s.id, s.userId, s.documentKind, s.documentCountry, s.expiryDate, s.frontImageRef ?? null, s.backImageRef ?? null, s.selfieRef ?? null, s.selfieCapturedInApp, s.submittedAt]
        );
        return true;
      } catch (e) {
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") return false;
        throw e;
      }
    },
    async get(id) {
      const r = await db.query("SELECT * FROM id_submission WHERE id = $1", [id]);
      return r.rows[0] ? toSubmission(r.rows[0]) : undefined;
    },
    async latestForUser(userId) {
      const r = await db.query("SELECT * FROM id_submission WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1", [userId]);
      return r.rows[0] ? toSubmission(r.rows[0]) : undefined;
    },
    async recentSubmittedAt(userId, since) {
      const r = await db.query("SELECT submitted_at FROM id_submission WHERE user_id = $1 AND submitted_at >= $2", [userId, since]);
      return r.rows.map(x => iso(x["submitted_at"]));
    },
    async listPending() {
      const r = await db.query(
        `SELECT s.*, u.display_name FROM id_submission s JOIN app_user u ON u.id = s.user_id
         WHERE s.status = 'pending' ORDER BY s.submitted_at LIMIT 200`
      );
      return r.rows.map(x => ({ submission: toSubmission(x), accountName: String(x["display_name"]) }));
    },
    async logAccess(submissionId, staffId, purpose, at) {
      await db.query("INSERT INTO id_review_access (submission_id, staff_user_id, viewed_at, purpose) VALUES ($1,$2,$3,$4)", [submissionId, staffId, at, purpose]);
    },
    async decide(next, prev, staffId, outcome, checklist) {
      const r = await db.query(
        `WITH upd AS (
           UPDATE id_submission SET status = $2, approvals = $3::jsonb, decided_at = $4::timestamptz
           WHERE id = $1 AND status = 'pending' AND approvals = $5::jsonb
           RETURNING id, user_id, status),
         rec AS (
           INSERT INTO id_review_decision (submission_id, staff_user_id, outcome, checklist, decided_at)
           SELECT id, $6::uuid, $7::text, $8::jsonb, $9::timestamptz FROM upd RETURNING 1),
         ver AS (
           INSERT INTO buyer_verification (user_id, id_verified_at, id_method)
           SELECT user_id, $9::timestamptz, 'manual_review' FROM upd WHERE status = 'approved'
           ON CONFLICT (user_id) DO UPDATE SET id_verified_at = EXCLUDED.id_verified_at, id_method = 'manual_review'
           RETURNING 1)
         SELECT count(*) AS n FROM upd`,
        [next.id, next.status, JSON.stringify(next.approvals), next.decidedAt ?? null, JSON.stringify(prev.approvals), staffId, outcome, JSON.stringify(checklist), new Date().toISOString()]
      );
      return Number(r.rows[0]?.["n"] ?? 0) === 1;
    },
    async withImagesToDelete() {
      const r = await db.query(
        "SELECT * FROM id_submission WHERE status IN ('approved','rejected') AND decided_at IS NOT NULL AND images_deleted_at IS NULL LIMIT 500"
      );
      return r.rows.map(toSubmission);
    },
    async markImagesDeleted(id, at) {
      await db.query("UPDATE id_submission SET front_image_key = NULL, back_image_key = NULL, selfie_key = NULL, images_deleted_at = $2 WHERE id = $1", [id, at]);
    }
  };
}

/** The staff role is read fresh from the database for an active account. */
export async function staffFor(db: Queryable, userId: string): Promise<StaffActor | undefined> {
  const r = await db.query("SELECT staff_role FROM app_user WHERE id = $1 AND status = 'active' AND staff_role IS NOT NULL", [userId]);
  const role = r.rows[0]?.["staff_role"];
  return role ? { id: userId, role: String(role) as StaffRole } : undefined;
}

const KEY = /^[0-9a-f-]{36}$/;

/**
 * No private encrypted storage is chosen yet, so by default there is none and ID submission stays blocked.
 * ID_STORAGE=local keeps files on this server's disk for local testing only and is ignored in production.
 */
export function fileStoreFromEnv(env: Record<string, string | undefined> = process.env): FileStore | undefined {
  if (env["ID_STORAGE"] !== "local" || env["NODE_ENV"] === "production") return undefined;
  const dir = path.resolve(env["ID_STORAGE_DIR"] ?? ".data/id-images");
  const file = (key: string) => {
    if (!KEY.test(key)) throw new Error("Invalid file key.");
    return path.join(dir, key);
  };
  return {
    async put(key, bytes) { await mkdir(dir, { recursive: true }); await writeFile(file(key), bytes, { flag: "wx" }); },
    async get(key) { try { return new Uint8Array(await readFile(file(key))); } catch { return undefined; } },
    async delete(key) { await rm(file(key), { force: true }); }
  };
}
