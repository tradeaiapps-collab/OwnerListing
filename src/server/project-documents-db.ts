import type { MaskBox } from "../domain/doc-masking";
import type { MaskRevision, ProjectDocKind, ProjectDocRecord, ProjectDocStore, ProjectDocVisibility } from "../domain/project-documents";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. Storage keys and fingerprints are selected only by storedFile. */
const SELECT = "SELECT d.id, d.project_id, d.kind, d.visibility, d.title, d.uploaded_by, d.content_type, d.size_bytes, d.uploaded_at, d.supersedes_id FROM investment_project_document";

const toDoc = (r: Record<string, unknown>): ProjectDocRecord => ({
  id: String(r["id"]), projectId: String(r["project_id"]), kind: r["kind"] as ProjectDocKind, visibility: r["visibility"] as ProjectDocVisibility,
  title: String(r["title"]), uploadedBy: String(r["uploaded_by"]), contentType: String(r["content_type"]), sizeBytes: Number(r["size_bytes"]),
  uploadedAt: new Date(r["uploaded_at"] as string | Date).toISOString(), ...(r["supersedes_id"] ? { supersedesId: String(r["supersedes_id"]) } : {})
});

export function createPgProjectDocStore(db: Queryable): ProjectDocStore {
  return {
    async documentsFor(projectId) { return (await db.query(`${SELECT} d WHERE d.project_id = $1 ORDER BY d.uploaded_at, d.id`, [projectId])).rows.map(toDoc); },
    async documentById(id) { const r = (await db.query(`${SELECT} d WHERE d.id = $1`, [id])).rows[0]; return r ? toDoc(r) : undefined; },
    async storedFile(id) {
      const r = (await db.query("SELECT storage_key, content_type FROM investment_project_document WHERE id = $1", [id])).rows[0];
      return r ? { storageKey: String(r["storage_key"]), contentType: String(r["content_type"]) } : undefined;
    },
    async addDocument(d) {
      const r = d.record;
      // supersedes_id is UNIQUE, so two replacements of the same version cannot both succeed.
      await db.query(
        `INSERT INTO investment_project_document (id, project_id, kind, visibility, title, uploaded_by, content_type, size_bytes, sha256, storage_key, supersedes_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid)`,
        [r.id, r.projectId, r.kind, r.visibility, r.title, r.uploadedBy, r.contentType, r.sizeBytes, d.sha256, d.storageKey, r.supersedesId ?? null]);
    },
    async unconfirmedInvestorDocs() {
      return (await db.query(
        `${SELECT} d WHERE d.visibility = 'investors'
           AND NOT EXISTS (SELECT 1 FROM investment_project_document s WHERE s.supersedes_id = d.id)
           AND COALESCE((SELECT m.confirmed FROM investment_project_document_mask m WHERE m.document_id = d.id ORDER BY m.revision DESC LIMIT 1), false) = false
         ORDER BY d.uploaded_at, d.id LIMIT 200`)).rows.map(toDoc);
    },
    async latestMask(documentId) {
      const r = (await db.query(
        "SELECT id, document_id, revision, boxes, terms, page_count, text_found, confirmed, actor_id, created_at FROM investment_project_document_mask WHERE document_id = $1 ORDER BY revision DESC LIMIT 1", [documentId])).rows[0];
      if (!r) return undefined;
      const rev: MaskRevision = {
        id: String(r["id"]), documentId: String(r["document_id"]), revision: Number(r["revision"]), boxes: r["boxes"] as MaskBox[], terms: r["terms"] as string[],
        pageCount: Number(r["page_count"]), textFound: r["text_found"] === true, confirmed: r["confirmed"] === true, actorId: String(r["actor_id"]),
        createdAt: new Date(r["created_at"] as string | Date).toISOString()
      };
      return rev;
    },
    async addMask(r) {
      // (document_id, revision) is UNIQUE: of two saves of the same revision only one wins.
      const res = await db.query(
        `INSERT INTO investment_project_document_mask (id, document_id, revision, boxes, terms, page_count, text_found, confirmed, actor_id)
         VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, $7, $8, $9) ON CONFLICT (document_id, revision) DO NOTHING RETURNING id`,
        [r.id, r.documentId, r.revision, JSON.stringify(r.boxes), r.terms, r.pageCount, r.textFound, r.confirmed, r.actorId]);
      return res.rows.length === 1;
    },
    async bytesUploadedSince(userId, sinceIso) {
      const res = await db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM investment_project_document WHERE uploaded_by = $1::uuid AND uploaded_at >= $2::timestamptz", [userId, sinceIso]);
      const total = Number(res.rows[0]?.["total"]);
      return Number.isFinite(total) ? total : undefined;
    }
  };
}
