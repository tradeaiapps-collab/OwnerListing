import { NextResponse } from "next/server";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { withApi } from "../../../../../src/server/api/with-api";
import { getTeamDeps } from "../../../../../src/server/agent-team-db";
import { archiveTeam, getTeam, updateTeam } from "../../../../../src/domain/agent-team";

type Ctx = { params: Promise<{ teamId: string }> };

/** Team detail for the caller's role: roster, dashboard, tasks and listings. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await getTeam(getTeamDeps(), actor, (await params).teamId);
  return r.ok ? NextResponse.json(r.value, { headers: { "cache-control": "no-store" } }) : failure(r);
}

/** Principal only: { name?, commissionRatePercent? }. */
async function handlePatch(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await updateTeam(getTeamDeps(), actor, (await params).teamId, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

/** Principal only: close the team and end every membership. */
async function handleDelete(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await archiveTeam(getTeamDeps(), actor, (await params).teamId);
  return r.ok ? NextResponse.json({ ok: true }) : failure(r);
}

export const GET = withApi(handleGet);
export const PATCH = withApi(handlePatch);
export const DELETE = withApi(handleDelete);
