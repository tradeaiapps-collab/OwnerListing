import { NextResponse } from "next/server";
import { MAX_PHOTOS_PER_REQUEST, suggestPhotoCaptions, type PhotoCaptionInput } from "../../../../../../src/domain/ai-photo-captions";
import { AI_PHOTO_CAPTION_RATE, withinLimit, windowStart } from "../../../../../../src/domain/rate-limit";
import { getAiEngine } from "../../../../../../src/server/ai";
import { getDb, getDeps } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { countHitPg } from "../../../../../../src/server/offer-flow-db";
import { requireListingHandler } from "../../../../../../src/server/owner-listing";
import { UUID } from "../../../../../../src/server/photo-route";
import { createPgPhotoStore } from "../../../../../../src/server/photos-db";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Owner (or appointed agent) asks Elena for caption and feature suggestions.
 * Body: { photos: [{ photoId, category?, note? }] } (up to 12, each photoId must belong to this listing).
 * Returns suggestions only: nothing is saved. AI off or failing = { state: "unavailable" } with status 200. Rate limited per user.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const id = (await params).id;
  if (!UUID.test(id)) return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  const handler = await requireListingHandler(req, id, "listing.describe");
  if (handler instanceof NextResponse) return handler;
  const body: unknown = await req.json().catch(() => null);
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["photos"] : undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PHOTOS_PER_REQUEST) {
    return NextResponse.json({ error: `Choose between 1 and ${MAX_PHOTOS_PER_REQUEST} photos.` }, { status: 400 });
  }
  const mine = new Set((await createPgPhotoStore(getDb()).photosForListing(id)).filter(p => p.kind === "photo").map(p => p.id));
  const photos: PhotoCaptionInput[] = [];
  for (const r of raw) {
    const o = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : {};
    if (typeof o["photoId"] !== "string" || !mine.has(o["photoId"])) return NextResponse.json({ error: "Unknown photo." }, { status: 400 });
    if ((o["category"] !== undefined && typeof o["category"] !== "string") || (o["note"] !== undefined && typeof o["note"] !== "string")) {
      return NextResponse.json({ error: "Invalid photo details." }, { status: 400 });
    }
    photos.push({ photoId: o["photoId"], ...(typeof o["category"] === "string" ? { category: o["category"] } : {}), ...(typeof o["note"] === "string" ? { note: o["note"] } : {}) });
  }
  const hits = await countHitPg(getDb(), `ai-photo:${handler.actor.userId}`, windowStart(new Date().toISOString(), AI_PHOTO_CAPTION_RATE.windowMs));
  if (!withinLimit(hits, AI_PHOTO_CAPTION_RATE.perUser)) return NextResponse.json({ error: "Too many suggestions. Try again later." }, { status: 429 });
  const l = handler.rec.listing;
  const result = await suggestPhotoCaptions(await getAiEngine(), {
    transactionType: l.transactionType, propertyType: l.propertyType, title: l.title,
    ...(l.suburb !== undefined ? { suburb: l.suburb } : {}), ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}),
    ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}), ...(l.parking !== undefined ? { parking: l.parking } : {})
  }, photos);
  const deps = getDeps();
  await deps.appendAudit({
    id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId: handler.actor.userId,
    aggregateType: "listing", aggregateId: id, eventType: "listing.ai_photo_captions_requested",
    correlationId: deps.newId(), payload: { aiState: result.state, photos: photos.length }
  });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
