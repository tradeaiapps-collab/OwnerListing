import { NextResponse } from "next/server";
import { addressSuggestDeps, runAddressGeocode } from "../../../../src/server/address-suggest";
import { getActor, getDb } from "../../../../src/server/context";
import { clientIp } from "../../../../src/server/client-ip";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";

/** Map position for a full address. Query: ?q=<address>. Signed-in users only. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await runAddressGeocode(addressSuggestDeps(getDb()), actor.userId, new URL(req.url).searchParams.get("q"), clientIp(req));
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
