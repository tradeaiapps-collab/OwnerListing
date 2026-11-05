import { NextResponse } from "next/server";
import { teamDetail, updateTeam } from "../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../src/server/agency-team-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Team, my role and its members (GET). Managers rename it or change the default split (PATCH). Non-members get 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await teamDetail(getAgencyTeamRepo(), actor, id);
  return r.ok ? NextResponse.json({ detail: r.value }) : failure(r);
}

async function handlePatch(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await updateTeam(getAgencyTeamRepo(), actor, id, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ team: r.value }) : failure(r);
}
export const GET = withApi(handleGet);
export const PATCH = withApi(handlePatch);
