import { NextResponse } from "next/server";
import { respondToAssignment } from "../../../../src/domain/assignment-service";
import { assignmentIds, getAssignmentRepo } from "../../../../src/server/assignment-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Body: { "action": "accept" | "decline" | "cancel" | "complete" }.
 * Contractor: accept, decline. Owner: cancel, complete. Only POST exists: assignments are never deleted.
 */
export async function POST(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await respondToAssignment(getAssignmentRepo(), actor, id, await req.json().catch(() => null), assignmentIds);
  return r.ok ? NextResponse.json({ assignment: r.value }) : failure(r);
}
