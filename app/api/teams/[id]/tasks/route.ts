import { NextResponse } from "next/server";
import { createTask, listTasks } from "../../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../../src/server/agency-team-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Tasks: managers see all, others see their own (GET). Create a task (POST); only managers may assign to others. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await listTasks(getAgencyTeamRepo(), actor, id);
  return r.ok ? NextResponse.json({ tasks: r.value }) : failure(r);
}

async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await createTask(getAgencyTeamRepo(), actor, id, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ task: r.value }, { status: 201 }) : failure(r);
}
export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
