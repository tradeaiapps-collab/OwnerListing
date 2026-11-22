import { NextResponse } from "next/server";
import { inviteContractor, listAssignments } from "../../../../../src/domain/assignment-service";
import { assignmentIds, getAssignmentRepo } from "../../../../../src/server/assignment-db";
import { getActor, getDb } from "../../../../../src/server/context";
import { notifyNewJob } from "../../../../../src/server/contractor-ops-notify";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The owner's assignments for one listing. Anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
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
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await inviteContractor(getAssignmentRepo(), actor, id, await req.json().catch(() => null), assignmentIds);
  if (!r.ok) return failure(r);
  // Tell the contractor on their own channels. The listing title only: the address stays hidden until they accept. Never blocks the invite.
  try {
    const db = getDb();
    const t = (await db.query("SELECT title FROM property_listing WHERE id = $1::uuid", [id])).rows[0];
    await notifyNewJob(db, r.value.contractorUserId, typeof t?.["title"] === "string" ? t["title"] : "a property", r.value.kind, r.value.id);
  } catch { /* the invite stands */ }
  return NextResponse.json({ assignment: r.value }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
