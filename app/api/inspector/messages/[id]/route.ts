import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { decideMessage } from "../../../../../src/server/elena-scheduling-db";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { action: "send", body? } sends Elena's draft (or your edited text) to the buyer in the app; { action: "skip" } drops it. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body: unknown = await req.json().catch(() => null);
  const r = await decideMessage(getDb(), actor.userId, id, body);
  return r.ok ? NextResponse.json(r) : failure(r);
}

export const POST = withApi(handlePost);
