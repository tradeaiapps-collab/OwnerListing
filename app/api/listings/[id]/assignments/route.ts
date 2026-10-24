import { NextResponse } from "next/server";
import { inviteContractor, listAssignments } from "../../../../../src/domain/assignment-service";
import { assignmentIds, getAssignmentRepo } from "../../../../../src/server/assignment-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";

type Ctx = { params: Promise<{ id: string }> };

/** The owner's assignments for one listing. Anyone else gets 404. */
export async function GET(req: Request, { params }: Ctx) {
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await listAssignments(getAssignmentRepo(), actor, id);
  return r.ok ? NextResponse.json({ assignments: r.value }) : failure(r);
}

/**
 * The listing's owner invites a registered contractor.
 * Body: { "kind": "photographer"|"solicitor"|"inspector"|"agent", "contractorUserId": "uuid" } or { "kind", "email" }.
 * The owner is always the signed-in user; the body cannot name one.
 */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await inviteContractor(getAssignmentRepo(), actor, id, await req.json().catch(() => null), assignmentIds);
  return r.ok ? NextResponse.json({ assignment: r.value }, { status: 201 }) : failure(r);
}
