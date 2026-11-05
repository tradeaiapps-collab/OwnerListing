import { NextResponse } from "next/server";
import { staffAssign, unroutedLeads } from "../../../../src/domain/lead-service";
import { getLeadDeps } from "../../../../src/server/lead-db";
import { failure } from "../../../../src/server/http";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Leads Elena did not route (cold, no licensed agent, or asked for a person). Staff only: they hold contact details. Needs the sales report permission. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const leads = await unroutedLeads(await getLeadDeps());
  return NextResponse.json({
    leads: leads.map(l => ({ id: l.id, channel: l.channel, tier: l.score.tier, score: l.score.score, status: l.state.status, slots: l.state.slots, updatedAt: l.updatedAt }))
  }, { headers: { "cache-control": "no-store" } });
}

/** Body: { "leadId": "...", "agentUserId": "..." }. Assigns the lead to a licensed, available agent. Needs user.manage. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  if (!b) return fail(400, "Send a JSON object.");
  const r = await staffAssign(await getLeadDeps(), staff.id, String(b["leadId"] ?? ""), b["agentUserId"]);
  return r.ok ? NextResponse.json({ assignment: r.value }) : failure(r);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
