import { NextResponse } from "next/server";
import { getListing, toPublicListing } from "../../../../../src/domain/listing-service";
import { withClient } from "../../../../../src/server/api/api-client-auth";
import { getDb, getDeps } from "../../../../../src/server/context";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

async function handleGet(req: Request, { params }: Ctx) {
  const { id } = await params;
  return withClient(getDb(), req, "listings.read", async () => {
    // No actor: the listing is returned only if anyone could see it, i.e. it is published.
    const r = await getListing(getDeps(), null, id);
    if (!r.ok || r.value.status !== "published") return NextResponse.json({ error: "Listing not found.", code: "not_found" }, { status: 404 });
    return NextResponse.json(toPublicListing(r.value));
  });
}

export const GET = withApi(handleGet);
