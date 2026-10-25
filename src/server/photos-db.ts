import type { JobAssignment } from "../domain/job-chat";
import type { PhotoMime } from "../domain/image-meta";
import { EMPTY_LAYOUT, coverOf, type Layout, type LayoutEntry, type PhotoKind, type PhotoRecord } from "../domain/listing-photos";
import type { PhotoStore, StoredSizes } from "../domain/photo-service";
import type { Queryable } from "./db";

/** Constant SQL, parameters only. Storage keys are selected only by storedSizes. */
const PHOTO_SELECT = "SELECT id, listing_id, kind, uploaded_by, content_type, width, height, thumb_key IS NOT NULL AS has_thumb, medium_key IS NOT NULL AS has_medium FROM listing_photo";

const toPhoto = (r: Record<string, unknown>): PhotoRecord => ({
  id: String(r["id"]), listingId: String(r["listing_id"]), kind: r["kind"] as PhotoKind, uploadedBy: String(r["uploaded_by"]),
  contentType: r["content_type"] as PhotoMime, width: Number(r["width"]), height: Number(r["height"]),
  variants: [...(r["has_thumb"] ? ["thumb" as const] : []), ...(r["has_medium"] ? ["medium" as const] : [])]
});

const toEntries = (v: unknown): LayoutEntry[] =>
  (Array.isArray(v) ? v : []).filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null).map(e => ({
    photoId: String(e["photoId"]), caption: typeof e["caption"] === "string" ? e["caption"] : "",
    alt: typeof e["alt"] === "string" ? e["alt"] : "", hidden: e["hidden"] === true
  }));

const toLayout = (r: Record<string, unknown> | undefined): Layout =>
  r ? { version: Number(r["version"]), entries: toEntries(r["entries"]), tourUrl: r["tour_url"] ? String(r["tour_url"]) : null } : EMPTY_LAYOUT;

const LAYOUT_SELECT = "SELECT listing_id, version, entries, tour_url FROM listing_photo_layout";

export function createPgPhotoStore(db: Queryable): PhotoStore {
  const currentLayout = async (q: Queryable, listingId: string) =>
    toLayout((await q.query(`${LAYOUT_SELECT} WHERE listing_id = $1 ORDER BY version DESC LIMIT 1`, [listingId])).rows[0]);
  const photosFor = async (q: Queryable, listingId: string) =>
    (await q.query(`${PHOTO_SELECT} WHERE listing_id = $1 ORDER BY uploaded_at, id`, [listingId])).rows.map(toPhoto);

  return {
    photosForListing: id => photosFor(db, id),
    async photoById(id) {
      const r = (await db.query(`${PHOTO_SELECT} WHERE id = $1`, [id])).rows[0];
      return r ? toPhoto(r) : undefined;
    },
    currentLayout: id => currentLayout(db, id),
    async assignmentsFor(listingId, userId) {
      const res = await db.query(
        "SELECT id, listing_id, owner_user_id, contractor_user_id, kind, status FROM job_assignment WHERE listing_id = $1 AND contractor_user_id = $2",
        [listingId, userId]);
      return res.rows.map(r => ({
        id: String(r["id"]), listingId: String(r["listing_id"]), ownerUserId: String(r["owner_user_id"]),
        contractorUserId: String(r["contractor_user_id"]), kind: r["kind"], status: r["status"]
      }) as JobAssignment);
    },
    async storedSizes(id) {
      const r = (await db.query("SELECT storage_key, content_type, thumb_key, medium_key FROM listing_photo WHERE id = $1", [id])).rows[0];
      if (!r) return {};
      const out: StoredSizes = { full: { storageKey: String(r["storage_key"]), contentType: r["content_type"] as PhotoMime } };
      if (r["thumb_key"]) out.thumb = { storageKey: String(r["thumb_key"]), contentType: "image/webp" };
      if (r["medium_key"]) out.medium = { storageKey: String(r["medium_key"]), contentType: "image/webp" };
      return out;
    },
    async bytesUploadedSince(userId, sinceIso) {
      const res = await db.query("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM listing_photo WHERE uploaded_by = $1::uuid AND uploaded_at >= $2::timestamptz", [userId, sinceIso]);
      const total = Number(res.rows[0]?.["total"]);
      return Number.isFinite(total) ? total : undefined;
    },
    async updateGallery(listingId, actorId, plan) {
      const run = async (q: Queryable) => {
        await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`listing_photos:${listingId}`]);
        const cur = await currentLayout(q, listingId);
        const p = plan(cur, new Map((await photosFor(q, listingId)).map(x => [x.id, x])));
        if (!p.ok) return p;
        if (p.expectVersion !== undefined && p.expectVersion !== cur.version) {
          return { ok: false as const, code: "conflict" as const, message: "The gallery was changed elsewhere. Reload and try again." };
        }
        if (p.addPhoto) {
          const { record: r, files, sha256, sizeBytes } = p.addPhoto;
          await q.query(
            `INSERT INTO listing_photo (id, listing_id, kind, uploaded_by, content_type, width, height, size_bytes, sha256, storage_key, thumb_key, medium_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [r.id, listingId, r.kind, r.uploadedBy, r.contentType, r.width, r.height, sizeBytes, sha256,
              files.full!.storageKey, files.thumb?.storageKey ?? null, files.medium?.storageKey ?? null]);
        }
        const version = cur.version + 1;
        await q.query(
          "INSERT INTO listing_photo_layout (listing_id, version, entries, tour_url, changed_by) VALUES ($1, $2, $3::jsonb, $4, $5)",
          [listingId, version, JSON.stringify(p.entries), p.tourUrl, actorId]);
        return { ok: true as const, value: { version } };
      };
      // Without a transaction the UNIQUE (listing_id, version) constraint still refuses a lost update.
      return db.transaction ? db.transaction(run) : run(db);
    },
    async coversFor(ids) {
      const out = new Map<string, { cover: ReturnType<typeof coverOf>["cover"]; photoCount: number }>();
      if (ids.length === 0) return out;
      const layouts = await db.query(`SELECT DISTINCT ON (listing_id) listing_id, version, entries, tour_url FROM listing_photo_layout WHERE listing_id = ANY($1::uuid[]) ORDER BY listing_id, version DESC`, [ids]);
      const photos = (await db.query(`${PHOTO_SELECT} WHERE listing_id = ANY($1::uuid[])`, [ids])).rows.map(toPhoto);
      const map = new Map(photos.map(p => [p.id, p]));
      for (const r of layouts.rows) out.set(String(r["listing_id"]), coverOf(toLayout(r), map));
      return out;
    }
  };
}
