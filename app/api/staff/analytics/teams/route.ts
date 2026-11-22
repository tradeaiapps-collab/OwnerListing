import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE, parseRange } from "../../../../../src/domain/admin-analytics";
import { buildTeamComparison } from "../../../../../src/domain/team-compare";
import { localDateInZone } from "../../../../../src/domain/timezone";
import { getDb } from "../../../../../src/server/context";
import { loadTeamFacts } from "../../../../../src/server/team-analytics-db";
import { fail, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Team comparison and trends for ?from=&to=&bucket=day|week|month (as platform analytics). Value and commission only with report.financial. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const parsed = parseRange(new URL(req.url).searchParams, localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE));
  if (!parsed.ok) return fail(400, parsed.error);
  const { teams, series } = await loadTeamFacts(getDb(), parsed.range);
  return NextResponse.json({ teams: buildTeamComparison(staff, teams, series), range: parsed.range }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
