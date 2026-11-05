import { NextResponse } from "next/server";
import { CONTENT_TYPES, exportFileName, exportReport, isExportFormat } from "../../../../../src/domain/report-export";
import { parseDefinition } from "../../../../../src/domain/saved-reports";
import { getDb } from "../../../../../src/server/context";
import { getReport, getRun } from "../../../../../src/server/saved-reports-db";
import { executeReport } from "../../../../../src/server/saved-reports-run";
import { canOpen, definitionFromParams, forViewer } from "../../../../../src/server/saved-reports-route";
import { fail, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Download as ?format=csv|xlsx|pdf plus one of: id (a saved report, run now), id and run (a stored snapshot, owner only), or the
 * definition itself (name, dimension, measures=a,b, period, from, to, compare=1). Every export is logged.
 */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const p = new URL(req.url).searchParams;
  const format = p.get("format");
  if (!isExportFormat(format)) return fail(400, "Choose csv, xlsx or pdf.");
  const db = getDb();
  const id = p.get("id");
  let out;
  if (id !== null) {
    if (!UUID_RE.test(id)) return fail(404, "Report not found.");
    const row = await getReport(db, id);
    if (!row || !canOpen(row, staff)) return fail(404, "Report not found.");
    const owner = row.ownerUserId === staff.id;
    const runId = p.get("run");
    if (runId !== null) {
      if (!owner || !UUID_RE.test(runId)) return fail(404, "Run not found.");
      out = await getRun(db, id, runId);
      if (!out) return fail(404, "Run not found.");
    } else {
      const input = owner ? row.definition : forViewer(row.definition, staff);
      if (!input) return fail(403, "Not allowed.");
      const def = parseDefinition(input, staff);
      if (!def.ok) return fail(400, def.error);
      out = await executeReport(db, staff, def.definition, new Date().toISOString());
    }
  } else {
    const def = parseDefinition(definitionFromParams(p), staff);
    if (!def.ok) return fail(400, def.error);
    out = await executeReport(db, staff, def.definition, new Date().toISOString());
  }
  await staffAudit(staff, "saved_report", id ?? staff.id, "staff.saved_report_exported",
    { format, dimension: out.result.dimension, measures: out.result.measures, from: out.result.range.from, to: out.result.range.to, snapshot: p.has("run") });
  return new NextResponse(new Uint8Array(exportReport(out.result, format, out.insights)), {
    headers: {
      "content-type": CONTENT_TYPES[format], "cache-control": "no-store",
      "content-disposition": `attachment; filename="${exportFileName(out.result, format)}"`
    }
  });
}

export const GET = withApi(handleGet);
