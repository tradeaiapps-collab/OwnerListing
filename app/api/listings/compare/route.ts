import { NextResponse } from "next/server";
import { compareProperties, parseCompareIds } from "../../../../src/domain/listing-compare";
import { cardPhoto } from "../../../../src/domain/listing-photos";
import type { PhotoStore } from "../../../../src/domain/photo-service";
import { getDb, getDeps } from "../../../../src/server/context";
import { createPgPhotoStore } from "../../../../src/server/photos-db";
import { loadPublished } from "../../../../src/server/search-assist-service";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Side-by-side facts for 2 to 4 published listings: ?ids=id,id,id. Public, card fields only (never the owner).
 * A missing, unpublished or malformed id is a clear 400 or 404 so the page can say which kind of problem it is.
 */
async function handleGet(req: Request) {
  const ids = parseCompareIds(new URL(req.url).searchParams.get("ids"));
  if (!ids) return NextResponse.json({ error: "Pick 2 to 4 different listings to compare." }, { status: 400 });
  const found = await loadPublished(getDeps(), ids);
  if (!found) return NextResponse.json({ error: "One of those listings is no longer available." }, { status: 404 });
  let covers: Awaited<ReturnType<PhotoStore["coversFor"]>> = new Map();
  try { covers = await createPgPhotoStore(getDb()).coversFor(ids); } catch { /* cards without photos */ }
  const listings = found.map(l => ({
    id: l.id, title: l.title, address: l.address, transactionType: l.transactionType,
    ...(l.priceCents !== undefined ? { priceCents: l.priceCents } : {}), ...cardPhoto(covers.get(l.id))
  }));
  return NextResponse.json({ listings, comparison: compareProperties(found) });
}

export const GET = withApi(handleGet);
