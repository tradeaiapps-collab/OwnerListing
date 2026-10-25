import { NextResponse } from "next/server";
import { respondToInvite } from "../../../../src/domain/agent-appointment-service";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../src/server/agent-appointment-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { "action": "accept" | "decline" | "withdraw" }. Agent: accept, decline. Owner: withdraw. */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await respondToInvite(getAgentAppointmentRepo(), actor, id, await req.json().catch(() => null), appointmentIds);
  return r.ok ? NextResponse.json(r.value) : failure(r);
}
