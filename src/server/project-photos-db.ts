import type { PhotoMime } from "../domain/image-meta";
import { EMPTY_LAYOUT, coverOf, type Layout, type LayoutEntry, type PhotoRecord } from "../domain/listing-photos";
import type { StoredSizes } from "../domain/photo-service";
import type { ProjectPhotoStore } from "../domain/project-photos";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. Storage keys are selected only by storedSizes. */
const PHOTO_SELECT = "SELECT id, project_id, uploaded_by, content_type, width, height, thumb_key IS NOT NULL AS has_thumb, medium_key IS NOT NULL AS has_medium FROM investment_project_photo";
const LAYOUT_SELECT = "SELECT project_id, version, entries FROM investment_project_photo_layout";

const toPhoto = (r: Record<string, unknown>): PhotoRecord => ({
  id: String(r["id"]), listingId: String(r["project_id"]), kind: "photo", uploadedBy: String(r["uploaded_by"]),
  contentType: r["content_type"] as PhotoMime, width: Number(r["width"]), height: Number(r["height"]),
  variants: [...(r["has_thumb"] ? ["thumb" as const] : []), ...(r["has_medium"] ? ["medium" as const] : [])]
});

const toEntries = (v: unknown): LayoutEntry[] =>
  (Array.isArray(v) ? v : []).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null).map(e => ({
    photoId: String(e["photoId"]), caption: typeof e["caption"] === "string" ? e["caption"] : "",
    alt: typeof e["alt"] === "string" ? e["alt"] : "", hidden: e["hidden"] === true
  }));

const toLayout = (r: Record<string, unknown> | undefined): Layout =>
  r ? { version: Number(r["version"]), entries: toEntries(r["entries"]), tourUrl: null } : EMPTY_LAYOUT;

export function createPgProjectPhotoStore(db: Queryable): ProjectPhotoStore {
  const currentLayout = async (q: Queryable, projectId: string) =>
    toLayout((await q.query(`${LAYOUT_SELECT} WHERE project_id = $1 ORDER BY version DESC LIMIT 1`, [projectId])).rows[0]);
  const photosFor = async (q: Queryable, projectId: string) =>
    (await q.query(`${PHOTO_SELECT} WHERE project_id = $1 ORDER BY uploaded_at, id`, [projectId])).rows.map(toPhoto);

  return {
    photosFor: id => photosFor(db, id),
    async photoById(id) {
      const r = (await db.query(`${PHOTO_SELECT} WHERE id = $1`, [id])).rows[0];
      return r ? toPhoto(r) : undefined;
    },
    currentLayout: id => currentLayout(db, id),
    async storedSizes(id) {
      const r = (await db.query("SELECT storage_key, content_type, thumb_key, medium_key FROM investment_project_photo WHERE id = $1", [id])).rows[0];
      if (!r) return {};
      const out: StoredSizes = { full: { storageKey: String(r["storage_key"]), contentType: r["content_type"] as PhotoMime } };
      if (r["thumb_key"]) out.thumb = { storageKey: String(r["thumb_key"]), contentType: "image/webp" };
      if (r["medium_key"]) out.medium = { storageKey: String(r["medium_key"]), contentType: "image/webp" };
      return out;
    },
    async bytesUploadedSince(userId, sinceIso) {
      const res = await db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM investment_project_photo WHERE uploaded_by = $1::uuid AND uploaded_at >= $2::timestamptz", [userId, sinceIso]);
      const total = Number(res.rows[0]?.["total"]);
      return Number.isFinite(total) ? total : undefined;
    },
    async updateGallery(projectId, actorId, plan) {
      const run = async (q: Queryable) => {
        await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project_photos:${projectId}`]);
        const cur = await currentLayout(q, projectId);
        const p = plan(cur, new Map((await photosFor(q, projectId)).map(x => [x.id, x])));
        if (!p.ok) return p;
        if (p.expectVersion !== undefined && p.expectVersion !== cur.version) {
          return { ok: false as const, code: "conflict" as const, message: "The gallery was changed elsewhere. Reload and try again." };
        }
        if (p.addPhoto) {
          const { record: r, files, sha256, sizeBytes } = p.addPhoto;
          await q.query(
            `INSERT INTO investment_project_photo (id, project_id, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key, thumb_key, medium_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [r.id, projectId, r.uploadedBy, r.contentType, r.width, r.height, sizeBytes, sha256,
              files.full!.storageKey, files.thumb?.storageKey ?? null, files.medium?.storageKey ?? null]);
        }
        const version = cur.version + 1;
        await q.query(
          "INSERT INTO investment_project_photo_layout (project_id, version, entries, changed_by) VALUES ($1, $2, $3::jsonb, $4)",
          [projectId, version, JSON.stringify(p.entries), actorId]);
        return { ok: true as const, value: { version } };
      };
      // Without a transaction the UNIQUE (project_id, version) constraint still refuses a lost update.
      return db.transaction ? db.transaction(run) : run(db);
    },
    async coversFor(ids) {
      const out = new Map<string, ReturnType<typeof coverOf>>();
      if (ids.length === 0) return out;
      const layouts = await db.query(`SELECT DISTINCT ON (project_id) project_id, version, entries FROM investment_project_photo_layout WHERE project_id = ANY($1::uuid[]) ORDER BY project_id, version DESC`, [ids]);
      const photos = (await db.query(`${PHOTO_SELECT} WHERE project_id = ANY($1::uuid[])`, [ids])).rows.map(toPhoto);
      const map = new Map(photos.map(p => [p.id, p]));
      for (const r of layouts.rows) out.set(String(r["project_id"]), coverOf(toLayout(r), map));
      return out;
    }
  };
}
