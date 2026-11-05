import { NextResponse } from "next/server";
import { getMarketplaceDb, removePortfolioItem } from "../../../../../../src/server/agent-marketplace-db";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ itemId: string }> };

/** Remove one of the agent's own portfolio entries. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await removePortfolioItem(getMarketplaceDb(), actor, (await params).itemId);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const DELETE = withApi(handleDelete);
