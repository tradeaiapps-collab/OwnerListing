import { NextResponse } from "next/server";
import { adminAnalytics, parseNewDeal, type DealStatus } from "../../../../src/domain/commission";
import { allCommissions, createDeal, listAgents } from "../../../../src/server/commission-db";
import { getDb } from "../../../../src/server/context";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const STATUSES: readonly string[] = ["expected", "earned", "cancelled"];

/** Deals and payments (?status=, ?agentId= to narrow), platform analytics over all deals, and the agent list for the new-deal form. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "commission.manage");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const status = q.get("status"), agentId = q.get("agentId");
  if (status && !STATUSES.includes(status)) return fail(400, "Unknown status.");
  if (agentId && !UUID_RE.test(agentId)) return fail(400, "Unknown agent.");
  const db = getDb();
  const filter = { ...(status ? { status: status as DealStatus } : {}), ...(agentId ? { agentUserId: agentId } : {}) };
  const [view, everything, agents] = await Promise.all([allCommissions(db, filter), allCommissions(db), listAgents(db)]);
  await staffAudit(staff, "staff_session", staff.id, "commission.viewed", { status, agentId });
  return NextResponse.json({ ...view, analytics: adminAnalytics(everything.deals, everything.payouts, new Date().toISOString().slice(0, 10)), agents }, { headers: { "cache-control": "no-store" } });
}

/** Records a new deal for an agent. The commission is calculated from the terms and the sale price. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "commission.manage");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const input = parseNewDeal(body);
  if (!input.ok) return fail(400, input.error);
  const r = await createDeal(getDb(), staff, input.value);
  return r.ok ? NextResponse.json(r.value, { status: 201 }) : fail(r.status, r.error);
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
