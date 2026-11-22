import { NextResponse } from "next/server";
import { getActor } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { cancelOwnBooking, repo } from "../../../../../src/server/open-inspection-service";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The buyer cancels their own upcoming booking; the agent is told. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await cancelOwnBooking(repo(), actor, (await params).id);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const POST = withApi(handlePost);
