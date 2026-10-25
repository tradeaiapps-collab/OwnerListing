import { NextResponse } from "next/server";
import { agentAppointments } from "../../../../src/domain/agent-appointment-service";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../src/server/agent-appointment-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";

/** The signed-in agent's open invitations and active appointments, each with licence status for the listing's state. */
export async function GET(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const r = await agentAppointments(getAgentAppointmentRepo(), actor, appointmentIds.now());
  return r.ok ? NextResponse.json({ items: r.value }) : failure(r);
}
