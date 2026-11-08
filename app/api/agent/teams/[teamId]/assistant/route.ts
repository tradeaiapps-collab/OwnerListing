import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../../../src/server/agent-team-db";
import { askTeamAssistant } from "../../../../../../src/domain/agent-team";

/** Ask the assistant about the team: { question }. Answers come from the team's numbers only; it never acts. */
async function handlePost(req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await askTeamAssistant(getTeamDeps(), actor, (await params).teamId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
