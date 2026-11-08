import { NextResponse } from "next/server";
import { revokeAppointment, setAgentPermissions } from "../../../../src/domain/agent-appointment-service";
import { appointmentIds, getAgentAppointmentRepo } from "../../../../src/server/agent-appointment-db";
import { getActor } from "../../../../src/server/context";
import { failure, unauthenticated } from "../../../../src/server/http";
import { csrfGuard } from "../../../../src/server/csrf";
import { withApi } from "../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Owner only. Body: { "action": "revoke" } ends the appointment at once, or
 * { "action": "set_permissions", "permissions": [...] } changes what the agent may do within the scope.
 * Appointments are never deleted.
 */
async function handlePost(req: Request, { params }: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.["action"];
  if (action === "revoke") {
    const r = await revokeAppointment(getAgentAppointmentRepo(), actor, id, appointmentIds);
    return r.ok ? NextResponse.json({ appointment: r.value }) : failure(r);
  }
  if (action === "set_permissions") {
    const r = await setAgentPermissions(getAgentAppointmentRepo(), actor, id, body, appointmentIds);
    return r.ok ? NextResponse.json({ appointment: r.value }) : failure(r);
  }
  return failure({ ok: false, code: "invalid", message: "Action must be revoke or set_permissions." });
}

export const POST = withApi(handlePost);
