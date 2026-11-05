import { NextResponse } from "next/server";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { withApi } from "../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../src/server/agent-team-db";
import { createTeam, getMyTeams } from "../../../../src/domain/agent-team";

/** The signed-in agent's team (if any) and pending invitations. */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getMyTeams(getTeamDeps(), actor);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Create a team with the caller as principal: { name }. */
async function handlePost(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await createTeam(getTeamDeps(), actor, await req.json().catch(() => null));
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
