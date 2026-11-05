import { NextResponse } from "next/server";
import { requestBooking } from "../../../../../src/domain/client-portal";
import { getClientPortalRepo, portalIds } from "../../../../../src/server/client-portal-db";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

/** Body: { listingId, kind: "viewing" | "consultation", startsAt, note? }. Asks the owner for a time on a published listing. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await requestBooking(getClientPortalRepo(), actor, await req.json().catch(() => null), portalIds);
  return r.ok ? NextResponse.json({ booking: r.value }, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
