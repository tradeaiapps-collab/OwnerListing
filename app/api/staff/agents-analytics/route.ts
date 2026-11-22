import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE } from "../../../../src/domain/admin-analytics";
import { agentLabel } from "../../../../src/domain/admin-elena-insights";
import { adminCsv, buildAdminAnalytics, parsePerformanceDays, periodRange } from "../../../../src/domain/agent-performance";
import { toCsv } from "../../../../src/domain/reports";
import { localDateInZone } from "../../../../src/domain/timezone";
import { loadPerformanceFacts } from "../../../../src/server/agent-performance-db";
import { getDb } from "../../../../src/server/context";
import { fail, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** All agents ranked by time to sale, with outlier flags, for ?days=30|90|180|365 (default 180). ?format=csv exports the same table. Names follow pii rules. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const days = parsePerformanceDays(q.get("days"));
  if (days === undefined) return fail(400, "Period must be 30, 90, 180 or 365 days.");
  const today = localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE);
  const range = periodRange(days, today);
  const facts = await loadPerformanceFacts(getDb(), range.from, range.to, "all");
  const analytics = buildAdminAnalytics(facts, days, today, (name, i) => agentLabel(staff, name, i));
  if (q.get("format") === "csv") {
    const { header, rows } = adminCsv(analytics);
    await staffAudit(staff, "agent_performance", "export", "agent_performance.exported", { days });
    return new NextResponse(toCsv(header, rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="agent-performance.csv"', "cache-control": "no-store" } });
  }
  return NextResponse.json({ analytics }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
