import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../../../src/server/agent-team-db";
import { assignTask } from "../../../../../../src/domain/agent-team";

/** Create a task: { title, assigneeId?, listingId?, dueOn? }. Managers assign to anyone; agents to themselves. */
async function handlePost(req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await assignTask(getTeamDeps(), actor, (await params).teamId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
