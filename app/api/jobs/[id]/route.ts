import { NextResponse } from "next/server";
import { maskJobAddress } from "../../../../src/domain/contractor-trust";
import { actOnJob } from "../../../../src/domain/job-board";
import { assignmentIds, getAssignmentRepo } from "../../../../src/server/assignment-db";
import { withApi } from "../../../../src/server/api/with-api";
import { createPgMarketStore } from "../../../../src/server/contractor-market-db";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { failure, unauthenticated } from "../../../../src/server/http";
import { makeJobNotify } from "../../../../src/server/job-notify";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One job, for the owner or the contractor on it only. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const job = UUID.test(id) ? await createPgMarketStore(getDb()).getJob(id) : undefined;
  if (!job || (job.ownerUserId !== actor.userId && job.contractorUserId !== actor.userId)) return failure({ ok: false, code: "not_found", message: "Not found." });
  return NextResponse.json({ job: { ...maskJobAddress(job, actor.userId), role: job.ownerUserId === actor.userId ? "owner" : "contractor" } });
}

/**
 * Body: { action: "accept" | "decline" (reason) | "cancel" | "complete" | "propose_time" (time) | "accept_time" | "reject_time" | "mark_done" }.
 * Contractor: accept, decline, propose_time, mark_done. Owner: cancel, complete, accept_time, reject_time. Jobs are never deleted.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await actOnJob({ assignments: getAssignmentRepo(), store: createPgMarketStore(getDb()), ids: assignmentIds, notify: makeJobNotify(getDb()) }, actor, id, await req.json().catch(() => null));
  return r.ok ? NextResponse.json({ job: maskJobAddress(r.value, actor.userId) }) : failure(r);
}
export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
