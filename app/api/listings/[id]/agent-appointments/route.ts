import { NextResponse } from "next/server";
import { inviteAgent, ownerAgentView } from "../../../../../src/domain/agent-appointment-service";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../../src/server/agent-appointment-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** The owner's view of this listing's agent: the active appointment and open invitations. Anyone else gets 404. */
async function handleGet(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await ownerAgentView(getAgentAppointmentRepo(), actor, id, appointmentIds.now());
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

/**
 * The listing's owner invites an agent account to manage the listing.
 * Body: { "agentUserId": "uuid" } or { "email": "..." }, plus optional "scope": "enquiries_and_offers" (default) | "full".
 * The agent must accept; nothing is granted until then.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await inviteAgent(getAgentAppointmentRepo(), actor, id, await req.json().catch(() => null), appointmentIds);
  return r.ok ? NextResponse.json({ invite: r.value }, { status: 201 }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
