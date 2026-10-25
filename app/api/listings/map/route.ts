import { NextResponse } from "next/server";
import { searchPublished } from "../../../../src/domain/listing-service";
import { MAX_MAP_PINS, parseSearchQuery } from "../../../../src/domain/listing-search";
import { getDb, getDeps } from "../../../../src/server/context";
import { cardPhoto } from "../../../../src/domain/listing-photos";
import type { PhotoStore } from "../../../../src/domain/photo-service";
import { createPgPhotoStore } from "../../../../src/server/photos-db";

/**
 * Public map pins for published listings that have a map location: the same filters as /api/listings plus
 * bbox=south,west,north,east. Returns at most MAX_MAP_PINS pins (newest first) and `total`, so the map can say
 * "zoom in to see all" when there are more. Only card fields go out; never the owner.
 */
export async function GET(req: Request) {
  const query = { ...parseSearchQuery(new URL(req.url).searchParams), located: true, page: 1, pageSize: MAX_MAP_PINS };
  const page = await searchPublished(getDeps(), query);
  let covers: Awaited<ReturnType<PhotoStore["coversFor"]>> = new Map();
  try { covers = await createPgPhotoStore(getDb()).coversFor(page.items.map(l => l.id)); } catch { /* pins without photos */ }
  const pins = page.items.map(l => ({
    id: l.id, title: l.title, address: l.address, latitude: l.latitude!, longitude: l.longitude!,
    transactionType: l.transactionType, propertyType: l.propertyType,
    ...(l.suburb ? { suburb: l.suburb } : {}), ...(l.postcode ? { postcode: l.postcode } : {}),
    ...(l.priceCents !== undefined ? { priceCents: l.priceCents } : {}),
    ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}),
    ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}),
    ...(l.parking !== undefined ? { parking: l.parking } : {}),
    ...cardPhoto(covers.get(l.id))
  }));
  return NextResponse.json({ pins, total: page.total, limit: MAX_MAP_PINS });
}
