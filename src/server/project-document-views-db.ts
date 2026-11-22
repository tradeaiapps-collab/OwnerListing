import type { ProjectDocViewStore } from "../domain/project-document-views";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. */
export function createPgDocViewStore(db: Queryable): ProjectDocViewStore {
  return {
    async addView(v, dedupeSinceIso) {
      const r = await db.query(
        `INSERT INTO investment_project_document_view (id, document_id, project_id, viewer_id, viewed_at)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz
          WHERE NOT EXISTS (SELECT 1 FROM investment_project_document_view x WHERE x.document_id = $2::uuid AND x.viewer_id = $4::uuid AND x.viewed_at >= $6::timestamptz)
         RETURNING id`,
        [v.id, v.documentId, v.projectId, v.viewerId, v.viewedAt, dedupeSinceIso]);
      return r.rows.length === 1;
    },
    async viewsFor(projectId, limit) {
      const r = await db.query(
        `SELECT v.document_id, v.viewer_id, u.display_name, v.viewed_at
           FROM investment_project_document_view v JOIN app_user u ON u.id = v.viewer_id
          WHERE v.project_id = $1::uuid ORDER BY v.viewed_at DESC LIMIT $2::int`, [projectId, limit]);
      return r.rows.map(x => ({
        documentId: String(x["document_id"]), viewerId: String(x["viewer_id"]), viewerName: String(x["display_name"]),
        viewedAt: new Date(x["viewed_at"] as string | Date).toISOString()
      }));
    }
  };
}
