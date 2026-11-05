import { NextResponse } from "next/server";
import { respondToInvite } from "../../../../src/domain/agent-appointment-service";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../src/server/agent-appointment-db";
import { getActor, getDb } from "../../../../src/server/context";
import { notifyInviteAnswered } from "../../../../src/server/notifier";
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
  if (!r.ok) return failure(r);
  const status = r.value.invite.status;
  if (status === "accepted" || status === "declined") await notifyInviteAnswered(getDb(), id, status === "accepted" ? "appointment_accepted" : "appointment_declined");
  return NextResponse.json(r.value);
}

export const POST = withApi(handlePost);
