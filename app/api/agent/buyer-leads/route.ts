import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";
import { getConversionDeps } from "../../../../src/server/buyer-conversion-db";
import { getBuyerConversion } from "../../../../src/domain/buyer-conversion";

/** The signed-in agent's buyers ranked by estimated chance of making an offer, with follow-up advice and model accuracy. Licensed agents only; own appointments only. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getBuyerConversion(getConversionDeps(), actor);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
