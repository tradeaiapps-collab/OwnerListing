import { NextResponse } from "next/server";
import { createDraft, listingWordingFlags, parseDraftInput, searchPublished, toPublicListing } from "../../../src/domain/listing-service";
import { distanceKm, parseSearchQuery } from "../../../src/domain/listing-search";
import { forbiddenFor } from "../../../src/domain/access";
import { getActor, getDb, getDeps } from "../../../src/server/context";
import { cardPhoto } from "../../../src/domain/listing-photos";
import type { PhotoStore } from "../../../src/domain/photo-service";
import { createPgPhotoStore } from "../../../src/server/photos-db";
import { failure, unauthenticated } from "../../../src/server/http";
import { csrfGuard } from "../../../src/server/csrf";
import { requireCurrentTerms } from "../../../src/server/terms-guard";
import { withApi } from "../../../src/server/api/with-api";

/** Public browse over published listings: filters, sort and pages (see parseSearchQuery for the parameters). */
async function handleGet(req: Request) {
  const query = parseSearchQuery(new URL(req.url).searchParams);
  const page = await searchPublished(getDeps(), query);
  // Cover photo and photo count per card. A photo lookup failure only means cards show without photos.
  let covers: Awaited<ReturnType<PhotoStore["coversFor"]>> = new Map();
  try { covers = await createPgPhotoStore(getDb()).coversFor(page.items.map(l => l.id)); } catch { /* cards without photos */ }
  const near = query.near;
  const listings = page.items.map(l => ({
    ...toPublicListing(l), ...cardPhoto(covers.get(l.id)),
    // Distance from the searched point, for the card ("2.3 km away").
    ...(near && l.latitude !== undefined && l.longitude !== undefined ? { distanceKm: Math.round(distanceKm(near.latitude, near.longitude, l.latitude, l.longitude) * 10) / 10 } : {})
  }));
  return NextResponse.json({ listings, total: page.total, page: page.page, pageSize: page.pageSize });
}

/** Creates a draft owned by the signed-in user. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "listing.create");
  if (denied) return failure(denied);
  const noTerms = await requireCurrentTerms(getDeps().termsCurrentFor, actor.userId);
  if (noTerms) return failure(noTerms);
  const parsed = parseDraftInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  const listing = await createDraft(getDeps(), actor, parsed.value);
  return NextResponse.json({ listing, wordingFlags: listingWordingFlags(listing) }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
