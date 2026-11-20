import { NextResponse } from "next/server";
import { ANALYTICS_TIME_ZONE } from "../../../../src/domain/admin-analytics";
import { agentLabel } from "../../../../src/domain/admin-elena-insights";
import { buildContractorRows, parseReportRange, reportCsv } from "../../../../src/domain/contractor-ops";
import { toCsv } from "../../../../src/domain/reports";
import { localDateInZone } from "../../../../src/domain/timezone";
import { getDb } from "../../../../src/server/context";
import { loadContractorFacts } from "../../../../src/server/contractor-ops-db";
import { fail, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/**
 * Jobs, response times, completion and complaints per contractor, for ?from=YYYY-MM-DD&to=YYYY-MM-DD (default last 90 days).
 * ?format=csv exports the same table. Names follow the staff member's personal-data permission.
 */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.operations");
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams;
  const range = parseReportRange(q.get("from"), q.get("to"), localDateInZone(new Date().toISOString(), ANALYTICS_TIME_ZONE));
  if (!range.ok) return fail(400, range.message);
  const rows = buildContractorRows(await loadContractorFacts(getDb(), range.value.from, range.value.to));
  const label = (name: string, i: number) => agentLabel(staff, name, i).replace(/^Agent (\d+)$/, "Contractor $1");
  if (q.get("format") === "csv") {
    const { header, rows: cells } = reportCsv(rows, label);
    await staffAudit(staff, "contractor_report", "export", "contractor_report.exported", range.value);
    return new NextResponse(toCsv(header, cells), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="contractor-report.csv"', "cache-control": "no-store" } });
  }
  return NextResponse.json({ range: range.value, rows: rows.map((r, i) => ({ ...r, contractorId: undefined, label: label(r.name, i), name: undefined })) }, { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const dynamic = "force-dynamic";
