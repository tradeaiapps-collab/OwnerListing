import { NextResponse } from "next/server";
import { withApi } from "../../../../src/server/api/with-api";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { listMyRequests, submitUrgentRequest } from "../../../../src/server/emergency-dispatch";
import { failure, unauthenticated } from "../../../../src/server/http";

/** The signed-in user's urgent requests and the ones sent to them as a contractor. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  return NextResponse.json({ requests: await listMyRequests(getDb(), actor) });
}

/** Sends an urgent request through Elena to contractors who are available now. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await submitUrgentRequest(getDb(), process.env, actor, await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
