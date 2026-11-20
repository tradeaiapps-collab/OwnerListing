import { NextResponse } from "next/server";
import { chooseForMe } from "../../../../../../src/domain/job-board";
import { assignmentIds, getAssignmentRepo } from "../../../../../../src/server/assignment-db";
import { withApi } from "../../../../../../src/server/api/with-api";
import { createPgMarketStore } from "../../../../../../src/server/contractor-market-db";
import { getActor, getDb } from "../../../../../../src/server/context";
import { csrfGuard } from "../../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../../src/server/http";
import { makeJobNotify } from "../../../../../../src/server/job-notify";

type Ctx = { params: Promise<{ id: string }> };

/** "Let Elena choose": offers the job to the best match for { kind }. Package 1 sends the first offer only; reminders and time negotiation come later. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await chooseForMe({ assignments: getAssignmentRepo(), store: createPgMarketStore(getDb()), ids: assignmentIds, notify: makeJobNotify(getDb()) }, actor, id, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ job: r.value.job, reasons: r.value.reasons }, { status: 201 }) : failure(r);
}
export const POST = withApi(handlePost);
