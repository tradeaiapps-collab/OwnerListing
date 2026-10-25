import { NextResponse } from "next/server";
import { buildStaffReport, staffReportCsv } from "../../../../src/domain/reports";
import { getDb } from "../../../../src/server/context";
import { loadStaffReport } from "../../../../src/server/reports-db";
import { staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Platform report (JSON, or CSV with ?format=csv). Each section is included only if the role allows it. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const report = buildStaffReport(staff, await loadStaffReport(getDb()));
  const csv = new URL(req.url).searchParams.get("format") === "csv";
  await staffAudit(staff, "staff_session", staff.id, csv ? "staff.report_exported" : "staff.report_viewed", { sections: Object.keys(report) });
  if (!csv) return NextResponse.json({ report });
  return new NextResponse(staffReportCsv(report), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="staff-report.csv"', "cache-control": "no-store" }
  });
}

export const GET = withApi(handleGet);
