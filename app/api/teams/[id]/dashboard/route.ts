import { NextResponse } from "next/server";
import { teamDashboard } from "../../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../../src/server/agency-team-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Team performance and, for managers, Elena's read of it. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await teamDashboard(getAgencyTeamRepo(), actor, id, agencyIds);
  return r.ok ? NextResponse.json({ dashboard: r.value }) : failure(r);
}
export const GET = withApi(handleGet);
