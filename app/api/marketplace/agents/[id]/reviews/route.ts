import { NextResponse } from "next/server";
import { getMarketplaceDb, marketplaceNow, submitReview } from "../../../../../../src/server/agent-marketplace-db";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Review an agent you have dealt with: { rating 1-5, title?, body? }. One review per person per agent. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await submitReview(getMarketplaceDb(), actor, (await params).id, await req.json().catch(() => null), marketplaceNow());
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
