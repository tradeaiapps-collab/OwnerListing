import { NextResponse } from "next/server";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { withApi } from "../../../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../../../src/server/agent-team-db";
import { inviteMember } from "../../../../../../src/domain/agent-team";

/** Invite a licensed agent by email: { email, role? }. They join only after accepting. */
async function handlePost(req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await inviteMember(getTeamDeps(), actor, (await params).teamId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const POST = withApi(handlePost);
