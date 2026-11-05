import { NextResponse } from "next/server";
import { metaConfig } from "../../../../src/adapters/ad-lead-providers";
import { LEAD_STATUSES } from "../../../../src/domain/ad-leads";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb, getStaff } from "../../../../src/server/context";
import { listAgents, listLeads, sourceReports, type LeadFilter } from "../../../../src/server/ad-lead-db";
import { withApi } from "../../../../src/server/api/with-api";

const NO_STORE = { "cache-control": "no-store" };
const STATUS_FILTERS = new Set<string>([...LEAD_STATUSES, "unassigned", "enquiry", "offer"]);
const RANGES = new Set([7, 30, 90, 0]);

/** The inbox page, per-source figures over a window (?days=7|30|90|0), the agents to assign to, and whether Meta is set up. ad_leads.manage only. */
async function handleGet(req: Request) {
  const staff = await getStaff(req);
  if (!staff) return NextResponse.json({ error: "Sign in as staff." }, { status: 401 });
  if (!staffCan(staff, "ad_leads.manage")) return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  const q = new URL(req.url).searchParams;
  const days = q.has("days") ? Number(q.get("days")) : 30;
  const status = q.get("status") ?? "";
  const filter: LeadFilter = {
    ...(STATUS_FILTERS.has(status) ? { status: status as NonNullable<LeadFilter["status"]> } : {}),
    ...(q.get("source") && /^[0-9a-f-]{36}$/i.test(q.get("source")!) ? { sourceId: q.get("source")! } : {}),
    ...(q.get("agent") && /^[0-9a-f-]{36}$/i.test(q.get("agent")!) ? { agentId: q.get("agent")! } : {}),
    limit: 25, offset: Math.max(0, Math.floor(Number(q.get("offset") ?? "0")) || 0)
  };
  const db = getDb();
  const [inbox, sources, agents] = await Promise.all([listLeads(db, filter), sourceReports(db, RANGES.has(days) ? days : 30, new Date().toISOString()), listAgents(db)]);
  return NextResponse.json({ ...inbox, pageSize: 25, offset: filter.offset, days: RANGES.has(days) ? days : 30, sources, agents, metaConfigured: metaConfig(process.env) !== null }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
