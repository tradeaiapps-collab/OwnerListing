import { NextResponse } from "next/server";
import { getActor } from "../../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../../../../src/server/agent-team-db";
import { updateTask } from "../../../../../../../src/domain/agent-team";

/** Mark a task open or done: { status }. The assignee or a manager. */
async function handlePatch(req: Request, { params }: { params: Promise<{ teamId: string; taskId: string }> }) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { teamId, taskId } = await params;
  const r = await updateTask(getTeamDeps(), actor, teamId, taskId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const PATCH = withApi(handlePatch);
