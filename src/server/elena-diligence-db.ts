import type { DiligenceRecord, DiligenceStore } from "../domain/elena-diligence-service";
import type { DiligenceSummary } from "../domain/elena-diligence";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. A published summary cannot change or be deleted (database trigger too). */
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const COLS = "id, project_id, status, summary, developer_note, source_keys, engine_version, created_by_user, approved_by, approved_at, created_at, updated_at";
const toRec = (r: Record<string, unknown>): DiligenceRecord => ({
  id: String(r["id"]), projectId: String(r["project_id"]), status: r["status"] as DiligenceRecord["status"], summary: r["summary"] as DiligenceSummary,
  developerNote: String(r["developer_note"] ?? ""), sourceKeys: (r["source_keys"] ?? []) as string[], engineVersion: Number(r["engine_version"]), createdByUser: String(r["created_by_user"]),
  ...(r["approved_by"] ? { approvedBy: String(r["approved_by"]) } : {}), ...(r["approved_at"] ? { approvedAt: iso(r["approved_at"]) } : {}),
  createdAt: iso(r["created_at"]), updatedAt: iso(r["updated_at"])
});

export function createPgDiligenceStore(db: Queryable): DiligenceStore {
  return {
    async listFor(projectId, includeDrafts) {
      const sql = includeDrafts
        ? `SELECT ${COLS} FROM elena_project_diligence WHERE project_id = $1::uuid ORDER BY created_at DESC, id LIMIT 50`
        : `SELECT ${COLS} FROM elena_project_diligence WHERE project_id = $1::uuid AND status = 'published' ORDER BY created_at DESC, id LIMIT 50`;
      return (await db.query(sql, [projectId])).rows.map(toRec);
    },
    async byId(id) { const r = (await db.query(`SELECT ${COLS} FROM elena_project_diligence WHERE id = $1::uuid`, [id])).rows[0]; return r ? toRec(r) : undefined; },
    async saveDraft(r) {
      const rows = (await db.query(
        `INSERT INTO elena_project_diligence (id, project_id, status, summary, developer_note, source_keys, engine_version, created_by_user, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'draft', $3::jsonb, $4, $5::text[], $6::int, $7::uuid, $8::timestamptz, $9::timestamptz)
         ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary, source_keys = EXCLUDED.source_keys, engine_version = EXCLUDED.engine_version, updated_at = EXCLUDED.updated_at
         RETURNING ${COLS}`,
        [r.id, r.projectId, JSON.stringify(r.summary), r.developerNote, r.sourceKeys, r.engineVersion, r.createdByUser, r.createdAt, r.updatedAt])).rows;
      return toRec(rows[0]!);
    },
    async setNote(id, note, at) {
      return (await db.query("UPDATE elena_project_diligence SET developer_note = $2, updated_at = $3::timestamptz WHERE id = $1::uuid AND status = 'draft' RETURNING id", [id, note, at])).rows.length === 1;
    },
    async publish(id, approverId, at) {
      return (await db.query("UPDATE elena_project_diligence SET status = 'published', approved_by = $2::uuid, approved_at = $3::timestamptz, updated_at = $3::timestamptz WHERE id = $1::uuid AND status = 'draft' RETURNING id", [id, approverId, at])).rows.length === 1;
    }
  };
}
