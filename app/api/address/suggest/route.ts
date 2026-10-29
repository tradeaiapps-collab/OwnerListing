import { NextResponse } from "next/server";
import { addressSuggestDeps, runAddressSuggest } from "../../../../src/server/address-suggest";
import { getActor, getDb } from "../../../../src/server/context";
import { clientIp } from "../../../../src/server/client-ip";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Street address suggestions while an owner types in the listing form. Query: ?q=6 Gable St&session=<token>.
 * Signed-in users only (this is not an open geocoding proxy) and rate limited. Nothing is stored.
 */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const url = new URL(req.url);
  const r = await runAddressSuggest(addressSuggestDeps(getDb()), actor.userId, url.searchParams.get("q"), url.searchParams.get("session"), clientIp(req));
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
