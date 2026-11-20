import { NextResponse } from "next/server";
import { reviewJob } from "../../../../../src/domain/job-board";
import { assignmentIds, getAssignmentRepo } from "../../../../../src/server/assignment-db";
import { withApi } from "../../../../../src/server/api/with-api";
import { createPgMarketStore } from "../../../../../src/server/contractor-market-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { makeJobNotify } from "../../../../../src/server/job-notify";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { rating: 1-5, body?: string }. Only the owner, only once, only after the job is complete. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await reviewJob({ assignments: getAssignmentRepo(), store: createPgMarketStore(getDb()), ids: assignmentIds, notify: makeJobNotify(getDb()) }, actor, id, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ job: r.value }) : failure(r);
}
export const POST = withApi(handlePost);
