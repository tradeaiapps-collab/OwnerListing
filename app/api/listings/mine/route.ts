import { NextResponse } from "next/server";
import { forbiddenFor } from "../../../../src/domain/access";
import { listMyListings } from "../../../../src/domain/listing-service";
import { getActor, getDeps } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

/** The signed-in owner's own listings. The owner id comes from the session, never from the request. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "listing.create");
  if (denied) return failure(denied);
  return NextResponse.json({ listings: await listMyListings(getDeps(), actor) });
}
