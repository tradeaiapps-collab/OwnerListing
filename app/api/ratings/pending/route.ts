import { NextResponse } from "next/server";
import { pendingRatings } from "../../../../src/server/agent-performance-db";
import { getActor, getDb } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** Sales the signed-in buyer has not rated yet. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ sales: await pendingRatings(getDb(), actor) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
