import { NextResponse } from "next/server";
import { addPortfolioItem, getMarketplaceDb, marketplaceNow } from "../../../../../src/server/agent-marketplace-db";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

/** Add a past sale to the portfolio: { suburb, propertyType?, soldOn: YYYY-MM-DD, priceCents?, note? }. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await addPortfolioItem(getMarketplaceDb(), actor, await req.json().catch(() => null), marketplaceNow());
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
