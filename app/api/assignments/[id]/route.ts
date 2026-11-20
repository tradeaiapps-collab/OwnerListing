import { NextResponse } from "next/server";
import { respondToAssignment } from "../../../../src/domain/assignment-service";
import { assignmentIds, getAssignmentRepo } from "../../../../src/server/assignment-db";
import { findOverlaps } from "../../../../src/domain/contractor-ops";
import { getActor, getDb } from "../../../../src/server/context";
import { committedSlots, getVisit } from "../../../../src/server/contractor-ops-db";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A contractor accepting a job whose time overlaps another accepted job is warned first (409, code "overlap"); sending
 * "acknowledgeOverlap": true accepts anyway. A warning only: if the check cannot run, the accept goes ahead.
 */
async function overlapOnAccept(userId: string, id: string, body: unknown): Promise<NextResponse | null> {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (b["action"] !== "accept" || b["acknowledgeOverlap"] === true) return null;
  try {
    const db = getDb();
    const visit = await getVisit(db, id);
    if (!visit) return null;
    const mine = await db.query("SELECT 1 FROM job_assignment WHERE id = $1::uuid AND contractor_user_id = $2::uuid", [id, userId]);
    if (mine.rows.length === 0) return null;
    const clash = findOverlaps({ assignmentId: id, startsAt: visit.startsAt, endsAt: visit.endsAt }, await committedSlots(db, userId));
    return clash.length === 0 ? null : NextResponse.json({ error: "This job's time overlaps another job you have accepted.", code: "overlap", overlaps: clash.map(s => ({ startsAt: s.startsAt, endsAt: s.endsAt })) }, { status: 409 });
  } catch {
    return null;
  }
}

/**
 * Body: { "action": "accept" | "decline" | "cancel" | "complete" }.
 * Contractor: accept, decline. Owner: cancel, complete. Only POST exists: assignments are never deleted.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const clash = await overlapOnAccept(actor.userId, id, body);
  if (clash) return clash;
  const r = await respondToAssignment(getAssignmentRepo(), actor, id, body, assignmentIds);
  return r.ok ? NextResponse.json({ assignment: r.value }) : failure(r);
}

export const POST = withApi(handlePost);
