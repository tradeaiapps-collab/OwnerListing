import type { UploadStore } from "../domain/document-upload";
import type { DocumentKind, DocumentRecord, DocumentStatus, Visibility } from "../domain/documents";
import type { JobAssignment } from "../domain/job-chat";
import type { Queryable } from "./db";

/** Constant text, parameters only. Storage keys and fingerprints are deliberately not selected. */
const DOC_SELECT = `SELECT d.id, d.listing_id, l.owner_user_id, d.uploaded_by, d.kind, d.visibility, d.status, d.supersedes_id
  FROM property_document d JOIN property_listing l ON l.id = d.listing_id`;

const toDocument = (r: Record<string, unknown>): DocumentRecord => ({
  id: String(r["id"]),
  listingId: String(r["listing_id"]),
  ownerUserId: String(r["owner_user_id"]),
  uploadedBy: String(r["uploaded_by"]),
  kind: r["kind"] as DocumentKind,
  visibility: r["visibility"] as Visibility,
  status: r["status"] as DocumentStatus,
  ...(r["supersedes_id"] ? { supersedesId: String(r["supersedes_id"]) } : {})
});

export function createPgDocumentStore(db: Queryable): UploadStore {
  return {
    async documentsForListing(listingId) {
      const res = await db.query(`${DOC_SELECT} WHERE d.listing_id = $1 ORDER BY d.uploaded_at, d.id`, [listingId]);
      return res.rows.map(toDocument);
    },
    async documentById(documentId) {
      const res = await db.query(`${DOC_SELECT} WHERE d.id = $1`, [documentId]);
      return res.rows[0] ? toDocument(res.rows[0]) : undefined;
    },
    async assignmentsFor(listingId, contractorUserId) {
      const res = await db.query(
        "SELECT id, listing_id, owner_user_id, contractor_user_id, kind, status FROM job_assignment WHERE listing_id = $1 AND contractor_user_id = $2",
        [listingId, contractorUserId]
      );
      return res.rows.map(r => ({
        id: String(r["id"]), listingId: String(r["listing_id"]), ownerUserId: String(r["owner_user_id"]),
        contractorUserId: String(r["contractor_user_id"]), kind: r["kind"], status: r["status"]
      }) as JobAssignment);
    },
    /** One statement: insert the new version and mark the earlier one superseded together. Insert and update only. */
    async addDocument(d, supersede) {
      const r = d.record;
      await db.query(
        `WITH ins AS (
           INSERT INTO property_document (id, property_id, listing_id, kind, storage_key, sha256, uploaded_by, source, declared_mime, size_bytes, visibility, status, supersedes_id)
           SELECT $1, l.property_id, l.id, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10::uuid FROM property_listing l WHERE l.id = $11
           RETURNING id)
         UPDATE property_document SET status = 'superseded' WHERE id = $10::uuid AND EXISTS (SELECT 1 FROM ins)`,
        [r.id, r.kind, d.storageKey, d.sha256, r.uploadedBy, r.uploadedBy === r.ownerUserId ? "owner_supplied" : "platform",
          d.declaredMime, d.sizeBytes, r.visibility, supersede?.id ?? null, r.listingId]
      );
    },
    async bytesUploadedSince(userId, sinceIso) {
      const res = await db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM property_document WHERE uploaded_by = $1::uuid AND uploaded_at >= $2::timestamptz", [userId, sinceIso]);
      const total = Number(res.rows[0]?.["total"]);
      return Number.isFinite(total) ? total : undefined;
    },
    async listingHasProperty(listingId) {
      const res = await db.query("SELECT 1 FROM property_listing WHERE id = $1 AND property_id IS NOT NULL", [listingId]);
      return res.rows.length > 0;
    },
    async storedFileFor(documentId) {
      const res = await db.query("SELECT storage_key, declared_mime FROM property_document WHERE id = $1", [documentId]);
      const row = res.rows[0];
      return row ? { storageKey: String(row["storage_key"]), contentType: String(row["declared_mime"]) } : undefined;
    },
    async recordDeletionRequest(r) {
      await db.query(
        "INSERT INTO document_deletion_request (document_id, requested_by, outcome, reason) VALUES ($1, $2, $3, $4)",
        [r.documentId, r.requestedBy, r.outcome, r.reason]
      );
    }
  };
}
