import type { ProjectDocKind, ProjectDocRecord, ProjectDocStore, ProjectDocVisibility } from "../domain/project-documents";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. Storage keys and fingerprints are selected only by storedFile. */
const SELECT = "SELECT id, project_id, kind, visibility, title, uploaded_by, content_type, size_bytes, uploaded_at, supersedes_id FROM investment_project_document";

const toDoc = (r: Record<string, unknown>): ProjectDocRecord => ({
  id: String(r["id"]), projectId: String(r["project_id"]), kind: r["kind"] as ProjectDocKind, visibility: r["visibility"] as ProjectDocVisibility,
  title: String(r["title"]), uploadedBy: String(r["uploaded_by"]), contentType: String(r["content_type"]), sizeBytes: Number(r["size_bytes"]),
  uploadedAt: new Date(r["uploaded_at"] as string | Date).toISOString(), ...(r["supersedes_id"] ? { supersedesId: String(r["supersedes_id"]) } : {})
});

export function createPgProjectDocStore(db: Queryable): ProjectDocStore {
  return {
    async documentsFor(projectId) { return (await db.query(`${SELECT} WHERE project_id = $1 ORDER BY uploaded_at, id`, [projectId])).rows.map(toDoc); },
    async documentById(id) { const r = (await db.query(`${SELECT} WHERE id = $1`, [id])).rows[0]; return r ? toDoc(r) : undefined; },
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
    async bytesUploadedSince(userId, sinceIso) {
      const res = await db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM investment_project_document WHERE uploaded_by = $1::uuid AND uploaded_at >= $2::timestamptz", [userId, sinceIso]);
      const total = Number(res.rows[0]?.["total"]);
      return Number.isFinite(total) ? total : undefined;
    }
  };
}
