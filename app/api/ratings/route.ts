import { NextResponse } from "next/server";
import { submitAgentRating } from "../../../src/server/agent-performance-db";
import { getActor, getDb } from "../../../src/server/context";
import { csrfGuard } from "../../../src/server/csrf";
import { failure, unauthenticated } from "../../../src/server/http";
import { withApi } from "../../../src/server/api/with-api";

/** A buyer rates the agent on a sale they bought: { listingId, rating 1-5, comment? }. The agent comes from the listing's appointment history. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await submitAgentRating(getDb(), actor, await req.json().catch(() => null), new Date().toISOString());
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
