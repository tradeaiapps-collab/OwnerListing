import { NextResponse } from "next/server";
import { withApi } from "../../../../../../src/server/api/with-api";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { replyToRequest } from "../../../../../../src/server/emergency-dispatch";
import { failure, unauthenticated } from "../../../../../../src/server/http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return failure({ ok: false, code: "not_found", message: "Not found." });
  const r = await replyToRequest(getDb(), process.env, actor, id, await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
