import { NextResponse } from "next/server";
import { addMember } from "../../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../../src/server/agency-team-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Manager adds an existing active account by email. Body: { email, role }. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await addMember(getAgencyTeamRepo(), actor, id, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ member: r.value }, { status: 201 }) : failure(r);
}
export const POST = withApi(handlePost);
