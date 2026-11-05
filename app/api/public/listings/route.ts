import { NextResponse } from "next/server";
import { parseSearchQuery } from "../../../../src/domain/listing-search";
import { searchPublished, toPublicListing } from "../../../../src/domain/listing-service";
import { withClient } from "../../../../src/server/api/api-client-auth";
import { getDb, getDeps } from "../../../../src/server/context";
import { withApi } from "../../../../src/server/api/with-api";

/** Published listings for integrators. Same filters as the site's search; the owner's id is never included. */
async function handleGet(req: Request) {
  return withClient(getDb(), req, "listings.read", async () => {
    const page = await searchPublished(getDeps(), parseSearchQuery(new URL(req.url).searchParams));
    return NextResponse.json({ listings: page.items.map(toPublicListing), total: page.total, page: page.page, pageSize: page.pageSize });
  });
}

export const GET = withApi(handleGet);
