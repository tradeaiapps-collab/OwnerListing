import { NextResponse } from "next/server";
import { getDb, getDeps } from "../../../../../src/server/context";
import { requireListingHandler } from "../../../../../src/server/owner-listing";
import { prequalsForListing } from "../../../../../src/server/prequalification-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pre-approval status beside each offer on the listing: verified, pending review or expired, with Elena's summary for verified ones.
 * For the owner and the appointed agent who may view offers. No buyer identity, no file and no bank details are returned.
 */
async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Listing not found." }, { status: 404 });
  const who = await requireListingHandler(req, id, "offers.view");
  if (who instanceof NextResponse) return who;
  const items = await prequalsForListing(getDb(), id, getDeps().now());
  return NextResponse.json({ items }, { headers: { "cache-control": "private, no-store" } });
}

export const GET = withApi(handleGet);
