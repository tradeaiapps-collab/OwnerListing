import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE } from "../../../../src/domain/admin-analytics";
import { buildReport, parseReportQuery, reportCsv } from "../../../../src/domain/admin-report-builder";
import { localDateInZone } from "../../../../src/domain/timezone";
import { getDb } from "../../../../src/server/context";
import { loadReport } from "../../../../src/server/admin-report-builder-db";
import { fail, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Grouped report for ?dimension=category|transaction|region|suburb|agent&from&to (JSON, or CSV with &format=csv). Every view and export is logged. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const params = new URL(req.url).searchParams;
  const parsed = parseReportQuery(params, localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE));
  if (!parsed.ok) return fail(400, parsed.error);
  const report = buildReport(staff, parsed.query, await loadReport(getDb(), parsed.query));
  const csv = params.get("format") === "csv";
  const { from, to } = parsed.query.range;
  await staffAudit(staff, "staff_session", staff.id, csv ? "staff.report_builder_exported" : "staff.report_builder_viewed",
    { dimension: parsed.query.dimension, from, to, revenue: report.revenueIncluded });
  if (!csv) return NextResponse.json({ report }, { headers: { "cache-control": "no-store" } });
  return new NextResponse(reportCsv(report), {
    headers: {
      "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
      "content-disposition": `attachment; filename="report-${parsed.query.dimension}-${from}-to-${to}.csv"`
    }
  });
}

export const GET = withApi(handleGet);
