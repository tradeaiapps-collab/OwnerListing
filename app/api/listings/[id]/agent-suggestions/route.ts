import { NextResponse } from "next/server";
import { inviteBestAgent, suggestAgents } from "../../../../../src/domain/agent-matching";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../../src/server/agent-appointment-db";
import { getAgentMatchingRepo } from "../../../../../src/server/agent-matching-db";
import { getActor } from "../../../../../src/server/context";
import { failure, unauthenticated } from "../../../../../src/server/http";
import { csrfGuard } from "../../../../../src/server/csrf";

type Ctx = { params: Promise<{ id: string }> };

/** Licensed, available agents ranked for this listing by area, expertise and spare capacity. Owner only; others get 404. */
export async function GET(req: Request, { params }: Ctx) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const r = await suggestAgents(getAgentMatchingRepo(), actor, id, appointmentIds.now());
  return r.ok ? NextResponse.json({ suggestions: r.value }) : failure(r);
}

/**
 * Automatic assignment. Body: { "action": "invite_best", "scope"?: ..., "permissions"?: [...] }.
 * Invites the best-ranked agent not already invited. The agent still has to accept.
 */
export async function POST(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.["action"] !== "invite_best") return failure({ ok: false, code: "invalid", message: "Action must be invite_best." });
  const r = await inviteBestAgent(getAgentMatchingRepo(), getAgentAppointmentRepo(), actor, id, body, appointmentIds);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : failure(r);
}
