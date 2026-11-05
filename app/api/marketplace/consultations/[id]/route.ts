import { NextResponse } from "next/server";
import { cancelConsultation, getMarketplaceDb, marketplaceNow } from "../../../../../src/server/agent-marketplace-db";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Cancel a future consultation. Either the client or the agent may; the other side is told. */
async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await cancelConsultation(getMarketplaceDb(), actor, (await params).id, marketplaceNow());
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const DELETE = withApi(handleDelete);
