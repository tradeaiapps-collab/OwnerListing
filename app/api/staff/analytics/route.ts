import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE, buildAnalytics, parseRange } from "../../../../src/domain/admin-analytics";
import { localDateInZone } from "../../../../src/domain/timezone";
import { getDb } from "../../../../src/server/context";
import { loadAnalytics } from "../../../../src/server/admin-analytics-db";
import { fail, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Platform analytics for ?from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=day|week|month (default: last 90 days by week). Revenue only with report.financial. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const parsed = parseRange(new URL(req.url).searchParams, localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE));
  if (!parsed.ok) return fail(400, parsed.error);
  const analytics = buildAnalytics(staff, parsed.range, await loadAnalytics(getDb(), parsed.range));
  return NextResponse.json({ analytics }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
