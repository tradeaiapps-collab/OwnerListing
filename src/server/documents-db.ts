import type { DocumentStore } from "../domain/document-service";
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

export function createPgDocumentStore(db: Queryable): DocumentStore {
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
    async recordDeletionRequest(r) {
      await db.query(
        "INSERT INTO document_deletion_request (document_id, requested_by, outcome, reason) VALUES ($1, $2, $3, $4)",
        [r.documentId, r.requestedBy, r.outcome, r.reason]
      );
    }
  };
}
