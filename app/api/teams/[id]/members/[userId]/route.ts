import { NextResponse } from "next/server";
import { changeMember, removeMember } from "../../../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../../../src/server/agency-team-db";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; userId: string }> };

/** Manager changes a role or split (PATCH). Manager removes a member, or a member leaves (DELETE = soft remove; history stays). */
async function handlePatch(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, userId } = await params;
  const r = await changeMember(getAgencyTeamRepo(), actor, id, userId, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ member: r.value }) : failure(r);
}

async function handleDelete(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, userId } = await params;
  const r = await removeMember(getAgencyTeamRepo(), actor, id, userId, agencyIds);
  return r.ok ? NextResponse.json({ member: r.value }) : failure(r);
}
export const PATCH = withApi(handlePatch);
export const DELETE = withApi(handleDelete);
