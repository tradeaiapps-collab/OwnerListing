import { NextResponse } from "next/server";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { setCancelAtPeriodEnd } from "../../../../src/server/subscription-db";
import { withApi } from "../../../../src/server/api/with-api";

/** Body: { cancel: boolean }. Cancels at the end of the paid period (features stay until then), or undoes that. */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as { cancel?: unknown } | null;
  if (typeof b?.cancel !== "boolean") return NextResponse.json({ error: "Send { cancel: true or false }." }, { status: 400 });
  const r = await setCancelAtPeriodEnd(getDb(), actor.userId, b.cancel);
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.message }, { status: r.code === "not_found" ? 404 : 400 });
}

export const POST = withApi(handlePost);
