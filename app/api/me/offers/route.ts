import { NextResponse } from "next/server";
import { withClient } from "../../../../src/server/api/api-client-auth";
import { getDb } from "../../../../src/server/context";
import { offersOnMyListings } from "../../../../src/server/public-api-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Offers on the key owner's listings: id, listing, price, status and time. No buyer, conditions or notes. */
async function handleGet(req: Request) {
  return withClient(getDb(), req, "offers.read", async c => NextResponse.json({ offers: await offersOnMyListings(getDb(), c.userId) }));
}

export const GET = withApi(handleGet);
