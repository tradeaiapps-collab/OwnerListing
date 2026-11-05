import { NextResponse } from "next/server";
import { setFavorite } from "../../../../../src/server/agent-performance-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

async function change(req: Request, on: boolean) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const body = (await req.json().catch(() => null)) as { agentId?: unknown } | null;
  const id = body && typeof body.agentId === "string" ? body.agentId : "";
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Choose an agent." }, { status: 400 });
  const r = await setFavorite(getDb(), actor, id, on);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/** Mark an agent as a favourite: { agentId }. */
export const POST = withApi((req: Request) => change(req, true));
/** Remove a favourite: { agentId }. */
export const DELETE = withApi((req: Request) => change(req, false));
