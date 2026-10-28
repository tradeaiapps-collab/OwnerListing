import { NextResponse } from "next/server";
import { revokeAppointment } from "../../../../src/domain/agent-appointment-service";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../src/server/agent-appointment-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** Body: { "action": "revoke" }. Owner only. The agent loses access at once. Appointments are never deleted. */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.["action"] !== "revoke") return failure({ ok: false, code: "invalid", message: "Action must be revoke." });
  const r = await revokeAppointment(getAgentAppointmentRepo(), actor, id, appointmentIds);
  return r.ok ? NextResponse.json({ appointment: r.value }) : failure(r);
}

export const POST = withApi(handlePost);
