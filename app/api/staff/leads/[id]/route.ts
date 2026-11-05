import { NextResponse } from "next/server";
import { LEAD_STATUSES, isUuid, type LeadStatus } from "../../../../../src/domain/lead-ads";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../../src/server/context";
import { csrfGuard } from "../../../../../src/server/csrf";
import { assignLead, setLeadStatus } from "../../../../../src/server/lead-db";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** {action:"assign", agentId: uuid|null} or {action:"status", status, reason?}. leads.manage only; every change is audited. */
async function handlePost(req: Request, ctx: Ctx) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "leads.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; agentId?: unknown; status?: unknown; reason?: unknown };
  const now = new Date().toISOString();
  let r;
  if (body.action === "assign") {
    if (body.agentId !== null && !isUuid(body.agentId)) return NextResponse.json({ error: "Pick an agent." }, { status: 400 });
    r = await assignLead(getDb(), staff.id, id, body.agentId, now);
  } else if (body.action === "status") {
    if (!LEAD_STATUSES.includes(body.status as LeadStatus)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";
    r = await setLeadStatus(getDb(), staff.id, id, body.status as LeadStatus, reason || null, now);
  } else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === "Lead not found." ? 404 : 400 });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
