import { NextResponse } from "next/server";
import { changeBooking } from "../../../../../../src/domain/client-portal";
import { getClientPortalRepo, portalIds } from "../../../../../../src/server/client-portal-db";
import { getActor } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { action: "cancel" } by the requester, or { action: "confirm" | "decline" } by the listing's owner or full-scope agent. Bookings are never deleted. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await changeBooking(getClientPortalRepo(), actor, id, await req.json().catch(() => null), portalIds.newId());
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const POST = withApi(handlePost);
