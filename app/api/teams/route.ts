import { NextResponse } from "next/server";
import { createTeam, myTeams } from "../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../src/server/agency-team-db";
import { getActor } from "../../../src/server/context";
import { failure, unauthenticated } from "../../../src/server/http";
import { csrfGuard } from "../../../src/server/csrf";
import { withApi } from "../../../src/server/api/with-api";

/** The signed-in user's teams (GET), or create a team as its first manager (POST, agent accounts only). */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await myTeams(getAgencyTeamRepo(), actor);
  return r.ok ? NextResponse.json({ teams: r.value }) : failure(r);
}

async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await createTeam(getAgencyTeamRepo(), actor, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ team: r.value }, { status: 201 }) : failure(r);
}
export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
