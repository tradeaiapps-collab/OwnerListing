import { NextResponse } from "next/server";
import { publishListing } from "../../../../../src/domain/listing-service";
import { forbiddenFor } from "../../../../../src/domain/access";
import { getActor, getDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

/** Runs the publish gate. Add ?dryRun=1 to check without publishing. A blocked result is a normal 200 with reasons. */
export async function POST(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "listing.publish");
  if (denied) return failure(denied);
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const { id } = await params;
  const r = await publishListing(getDeps(), actor, id, dryRun);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
