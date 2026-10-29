import { NextResponse } from "next/server";
import { addressSuggestDeps, runAddressResolve } from "../../../../src/server/address-suggest";
import { getActor, getDb } from "../../../../src/server/context";
import { clientIp } from "../../../../src/server/client-ip";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** Street, suburb, state and postcode for a picked address suggestion. Query: ?id=<suggestion id>&session=<token>. Signed-in users only. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const url = new URL(req.url);
  const r = await runAddressResolve(addressSuggestDeps(getDb()), actor.userId, url.searchParams.get("id"), url.searchParams.get("session"), clientIp(req));
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
