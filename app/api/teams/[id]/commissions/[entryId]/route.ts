import { NextResponse } from "next/server";
import { advanceCommission } from "../../../../../../src/domain/agency-team";
import { agencyIds, getAgencyTeamRepo } from "../../../../../../src/server/agency-team-db";
import { getActor } from "../../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; entryId: string }> };

/** Manager approves or marks an entry paid. Body: { action: "approve" | "mark_paid", payoutReference? }. A record only: no money moves here. */
async function handlePatch(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id, entryId } = await params;
  const r = await advanceCommission(getAgencyTeamRepo(), actor, id, entryId, await req.json().catch(() => null), agencyIds);
  return r.ok ? NextResponse.json({ commission: r.value }) : failure(r);
}
export const PATCH = withApi(handlePatch);
