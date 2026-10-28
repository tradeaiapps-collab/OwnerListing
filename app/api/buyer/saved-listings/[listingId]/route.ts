import { NextResponse } from "next/server";
import { parseListingId, unsaveListing } from "../../../../../src/domain/saved-listings";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { getSavedListingRepo } from "../../../../../src/server/saved-listing-context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ listingId: string }> };

/** Removes the signed-in buyer's own bookmark. A bookmark is a list entry, not chat or a published file. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const id = parseListingId((await params).listingId);
  if (!id.ok) return failure(id);
  const r = await unsaveListing(getSavedListingRepo(), actor, id.value);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const DELETE = withApi(handleDelete);
