import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";
import { getWorkspaceDeps } from "../../../../src/server/agent-workspace-db";
import { getWorkspace } from "../../../../src/domain/agent-workspace";

/** The signed-in agent's performance, forecast and ranked leads. Licensed agents only; scoped to their own appointments. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getWorkspace(getWorkspaceDeps(), actor);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

export const GET = withApi(handleGet);
