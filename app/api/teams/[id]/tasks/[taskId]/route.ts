import { NextResponse } from "next/server";
import { updateTask } from "../../../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../../../src/server/agency-team-db";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

/** Update a task. The assignee may change its status; managers may change anything. */
async function handlePatch(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, taskId } = await params;
  const r = await updateTask(getAgencyTeamRepo(), actor, id, taskId, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ task: r.value }) : failure(r);
}
export const PATCH = withApi(handlePatch);
