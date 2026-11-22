import { NextResponse } from "next/server";
import { getMarketplaceDb, listMyConsultations, marketplaceNow } from "../../../../src/server/agent-marketplace-db";
import { getActor } from "../../../../src/server/context";
import { unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in user's consultations, as client and (for agents) as host. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ consultations: await listMyConsultations(getMarketplaceDb(), actor, marketplaceNow()) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
