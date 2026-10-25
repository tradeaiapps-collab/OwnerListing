import { NextResponse } from "next/server";
import { buyerOnly, parseListingId, saveListing } from "../../../../src/domain/saved-listings";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { getSavedListingRepo } from "../../../../src/server/saved-listing-context";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in buyer's own bookmarked (published) listings. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = buyerOnly(actor);
  if (denied) return failure(denied);
  return NextResponse.json({ listings: await getSavedListingRepo().list(actor.userId) });
}

/** Body: { listingId }. Bookmarks a published listing for the signed-in buyer. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = buyerOnly(actor);
  if (denied) return failure(denied);
  const body = await req.json().catch(() => null);
  const id = parseListingId(typeof body === "object" && body !== null ? (body as Record<string, unknown>)["listingId"] : undefined);
  if (!id.ok) return failure(id);
  const r = await saveListing(getSavedListingRepo(), actor, id.value);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
