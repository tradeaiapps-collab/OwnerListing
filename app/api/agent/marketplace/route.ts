import { NextResponse } from "next/server";
import { parseMarketplaceProfile } from "../../../../src/domain/agent-marketplace";
import { getMarketplaceDb, getOwnMarketplace, marketplaceNow, saveOwnMarketplace } from "../../../../src/server/agent-marketplace-db";
import { getActor } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** The signed-in agent's marketplace settings, weekly hours and own portfolio entries. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getOwnMarketplace(getMarketplaceDb(), actor);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Replaces the marketplace settings and weekly hours. The agent id comes from the session. */
async function handlePut(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const v = parseMarketplaceProfile(await req.json().catch(() => null));
  if (!v.ok) return failure(v);
  const r = await saveOwnMarketplace(getMarketplaceDb(), actor, v.value, marketplaceNow());
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
