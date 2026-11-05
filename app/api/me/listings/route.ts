import { NextResponse } from "next/server";
import { listMyListings, toPublicListing } from "../../../../src/domain/listing-service";
import { withClient } from "../../../../src/server/api/api-client-auth";
import { getDb, getDeps } from "../../../../src/server/context";
import { withApi } from "../../../../src/server/api/with-api";

/** The key owner's own listings, any status. */
async function handleGet(req: Request) {
  return withClient(getDb(), req, "listings.read", async c => {
    const listings = await listMyListings(getDeps(), { userId: c.userId, userType: c.userType as never });
    return NextResponse.json({ listings: listings.map(toPublicListing) });
  });
}

export const GET = withApi(handleGet);
