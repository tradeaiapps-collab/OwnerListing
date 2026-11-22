import type { ElenaPhotoFacts, ElenaReview } from "../domain/listing-validation";
import { createPgPhotoStore } from "./photos-db";
import type { Queryable } from "./db";

/** The listing's visible gallery as Elena reads it (hidden photos are not shown to buyers, so they do not count). */
export async function elenaPhotoFactsPg(db: Queryable, listingId: string): Promise<ElenaPhotoFacts> {
  const store = createPgPhotoStore(db);
  const [layout, photos] = await Promise.all([store.currentLayout(listingId), store.photosForListing(listingId)]);
  const byId = new Map(photos.map(p => [p.id, p]));
  const visible = layout.entries.filter(e => !e.hidden).map(e => ({ e, p: byId.get(e.photoId) })).filter(x => x.p !== undefined);
  return {
    photos: visible.filter(x => x.p!.kind === "photo").map(x => ({ width: x.p!.width, height: x.p!.height, alt: x.e.alt, category: x.e.category ?? "" })),
    floorplans: visible.filter(x => x.p!.kind === "floorplan").length
  };
}

/** One row per listing: staff review it after it goes live. Re-publishing refreshes the row and reopens it. */
export async function queueForModerationPg(db: Queryable, listingId: string, review: ElenaReview, actorUserId: string): Promise<void> {
  await db.query(
    `INSERT INTO listing_moderation_queue (listing_id, published_by, advice_count, advice)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (listing_id) DO UPDATE SET published_by = EXCLUDED.published_by, advice_count = EXCLUDED.advice_count,
       advice = EXCLUDED.advice, status = 'open', queued_at = now(), reviewed_at = NULL, reviewed_by = NULL`,
    [listingId, actorUserId, review.advice, JSON.stringify(review.findings.filter(f => f.severity === "advice").map(f => ({ id: f.id, area: f.area, message: f.message })))]
  );
}
