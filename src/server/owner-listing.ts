import type { NextResponse } from "next/server";
import type { Actor, ListingRecord } from "../domain/listing-service";
import { getActor, getDeps } from "./context";
import { failure, unauthenticated } from "./http";

/** Signed-in owner of this listing, or a 401/404 response. Everyone else (other owners, agents, buyers) gets 404. */
export async function requireListingOwner(req: Request, id: string): Promise<{ actor: Actor; rec: ListingRecord } | NextResponse> {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const rec = await getDeps().repo.get(id);
  if (actor.userType !== "owner" || !rec || rec.listing.ownerUserId !== actor.userId) {
    return failure({ ok: false, code: "not_found", message: "Listing not found." });
  }
  return { actor, rec };
}
