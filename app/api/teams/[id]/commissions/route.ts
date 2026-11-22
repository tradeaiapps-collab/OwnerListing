import { NextResponse } from "next/server";
import { listCommissions, recordCommission } from "../../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../../src/server/agency-team-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Commission records: managers see all, agents their own, staff none (GET). A manager records one (POST); the split is fixed on it. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await listCommissions(getAgencyTeamRepo(), actor, id);
  return r.ok ? NextResponse.json({ commissions: r.value }) : failure(r);
}

async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await recordCommission(getAgencyTeamRepo(), actor, id, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ commission: r.value }, { status: 201 }) : failure(r);
}
export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
