import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE, parseRange } from "../../../../../src/domain/admin-analytics";
import { shiftDays } from "../../../../../src/domain/agent-benchmark";
import { buildTeamTrends } from "../../../../../src/domain/team-trends";
import { localDateInZone } from "../../../../../src/domain/timezone";
import { listAgencyTeams, loadAgentFacts } from "../../../../../src/server/analytics-suite-db";
import { getDb } from "../../../../../src/server/context";
import { fail, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Team trends for ?from=&to=&bucket=day|week|month (default last 90 days by week) and optional ?team=<agency team id>. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const parsed = parseRange(q, localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE));
  if (!parsed.ok) return fail(400, parsed.error);
  const team = q.get("team") || undefined;
  if (team && !UUID_RE.test(team)) return fail(400, "Unknown team.");
  const db = getDb();
  const r = parsed.range;
  const span = Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;
  const [facts, teams] = await Promise.all([loadAgentFacts(db, shiftDays(r.from, -span), r.to, team), listAgencyTeams(db)]);
  const scope = team ? teams.find(t => t.id === team)?.name : "All agents";
  if (!scope) return fail(400, "Unknown team.");
  return NextResponse.json({ trends: buildTeamTrends(staff, facts, r, scope), teams }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
