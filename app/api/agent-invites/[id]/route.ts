import { NextResponse } from "next/server";
import { respondToInvite } from "../../../../src/domain/agent-appointment-service";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../src/server/agent-appointment-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { "action": "accept" | "decline" | "withdraw" }. Agent: accept, decline. Owner: withdraw. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await respondToInvite(getAgentAppointmentRepo(), actor, id, await req.json().catch(() => null), appointmentIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}

export const POST = withApi(handlePost);
