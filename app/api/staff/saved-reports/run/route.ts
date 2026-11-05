import { NextResponse } from "next/server";
import { parseDefinition } from "../../../../../src/domain/saved-reports";
import { getDb } from "../../../../../src/server/context";
import { getReport, recordRun } from "../../../../../src/server/saved-reports-db";
import { executeReport } from "../../../../../src/server/saved-reports-run";
import { canOpen, forViewer } from "../../../../../src/server/saved-reports-route";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * POST { definition } runs an unsaved report; POST { id, record? } runs a saved one now (record: true by its owner keeps the result in
 * the report's history for later comparison). Always runs live with the caller's own permissions.
 */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const db = getDb();
  const nowIso = new Date().toISOString();
  let reportId: string | null = null, owner = false;
  let defInput: unknown = body["definition"];
  if (typeof body["id"] === "string") {
    if (!UUID_RE.test(body["id"])) return fail(404, "Report not found.");
    const row = await getReport(db, body["id"]);
    if (!row || !canOpen(row, staff)) return fail(404, "Report not found.");
    reportId = row.id; owner = row.ownerUserId === staff.id;
    defInput = owner ? row.definition : forViewer(row.definition, staff);
    if (!defInput) return fail(403, "Not allowed.");
  }
  const def = parseDefinition(defInput, staff);
  if (!def.ok) return fail(400, def.error);
  const out = await executeReport(db, staff, def.definition, nowIso);
  const recorded = reportId !== null && owner && body["record"] === true;
  const runId = recorded ? await recordRun(db, reportId!, "manual", staff.id, out.result, out.insights) : null;
  await staffAudit(staff, "saved_report", reportId ?? staff.id, "staff.saved_report_run",
    { dimension: def.definition.dimension, measures: def.definition.measures, saved: reportId !== null, recorded });
  return NextResponse.json({ ...out, runId }, { headers: { "cache-control": "no-store" } });
}

export const POST = withApi(handlePost);
