import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../../../src/server/agent-team-db";
import { respondToInvitation } from "../../../../../../src/domain/agent-team";

/** The invited agent answers: { accept: boolean }. */
async function handlePut(req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await respondToInvitation(getTeamDeps(), actor, (await params).teamId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const PUT = withApi(handlePut);
