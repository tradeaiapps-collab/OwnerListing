import { NextResponse } from "next/server";
import { publishListing } from "../../../../../src/domain/listing-service";
import { forbiddenFor } from "../../../../../src/domain/access";
import { getActor, getDeps } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";
import { requireRecentMfa } from "../../../../../src/server/mfa-context";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Runs the publish gate. Add ?dryRun=1 to check without publishing. A blocked result is a normal 200 with reasons.
 * A real publish needs a second-factor check in the last 15 minutes (403 mfa_required otherwise); a dry run does not.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const denied = forbiddenFor({ id: actor.userId, role: actor.userType }, "listing.publish");
  if (denied) return failure(denied);
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  if (!dryRun) {
    const stale = await requireRecentMfa(req);
    if (stale) return stale;
  }
  const { id } = await params;
  const r = await publishListing(getDeps(), actor, id, dryRun);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
