import { NextResponse } from "next/server";
import { getActor } from "../../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../../src/server/http";
import { withApi } from "../../../../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../../../../src/server/agent-team-db";
import { removeMember, updateMember } from "../../../../../../../src/domain/agent-team";

type Ctx = { params: Promise<{ teamId: string; userId: string }> };

/** Principal only: { role?, agentSharePercent? }. */
async function handlePatch(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { teamId, userId } = await params;
  const r = await updateMember(getTeamDeps(), actor, teamId, userId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

/** Remove a member, or leave the team when userId is the caller. */
async function handleDelete(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { teamId, userId } = await params;
  const r = await removeMember(getTeamDeps(), actor, teamId, userId);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const PATCH = withApi(handlePatch);
export const DELETE = withApi(handleDelete);
