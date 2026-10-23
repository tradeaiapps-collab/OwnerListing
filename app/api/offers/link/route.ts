import { NextResponse } from "next/server";
import { checkOfferLink } from "../../../../src/domain/offer-service";
import { getActor, getOfferDeps } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

/** Checks an offer link for the signed-in buyer and says which property it is for. */
export async function GET(req: Request) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const r = await checkOfferLink(getOfferDeps(), actor, token);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
