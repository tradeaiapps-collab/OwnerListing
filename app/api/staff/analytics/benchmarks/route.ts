import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE } from "../../../../../src/domain/admin-analytics";
import { buildBenchmark, lastMonths, parsePeriodDays, periods, TREND_MONTHS } from "../../../../../src/domain/agent-benchmark";
import { localDateInZone } from "../../../../../src/domain/timezone";
import { listAgencyTeams, loadAgentFacts } from "../../../../../src/server/analytics-suite-db";
import { getDb } from "../../../../../src/server/context";
import { fail, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Agent benchmarks for ?days=30|90|180|365 (default 90) and optional ?team=<agency team id>. Commission only with report.financial. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const days = parsePeriodDays(q.get("days"));
  if (days === undefined) return fail(400, "Period must be 30, 90, 180 or 365 days.");
  const team = q.get("team") || undefined;
  if (team && !UUID_RE.test(team)) return fail(400, "Unknown team.");
  const today = localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE);
  const { previous } = periods(days, today);
  const from = [previous.from, `${lastMonths(today, TREND_MONTHS)[0]}-01`].sort()[0]!;
  const db = getDb();
  const [facts, teams] = await Promise.all([loadAgentFacts(db, from, today, team), listAgencyTeams(db)]);
  if (team && !teams.some(t => t.id === team)) return fail(400, "Unknown team.");
  return NextResponse.json({ benchmark: buildBenchmark(staff, facts, days, today), teams }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
