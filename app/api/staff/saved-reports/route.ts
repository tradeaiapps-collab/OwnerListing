import { NextResponse } from "next/server";
import { describeSchedule, nextRunAfter, parseDefinition, parseSchedule, type ReportSchedule } from "../../../../src/domain/saved-reports";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb } from "../../../../src/server/context";
import { createReport, listReports } from "../../../../src/server/saved-reports-db";
import { catalogueFor, forViewer } from "../../../../src/server/saved-reports-route";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** GET: the reports this staff member can open (own and shared) with the builder's choices. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const rows = await listReports(getDb(), staff.id);
  const reports = rows.flatMap(r => {
    const mine = r.ownerUserId === staff.id;
    const definition = mine ? r.definition : forViewer(r.definition, staff);
    if (!definition) return [];
    return [{
      id: r.id, mine, definition, shared: r.shared, lastRunAt: r.lastRunAt,
      schedule: mine && r.schedule ? { ...r.schedule, description: describeSchedule(r.schedule) } : null
    }];
  });
  return NextResponse.json({ reports, catalogue: catalogueFor(staff), canExportFinancial: staffCan(staff, "report.financial") }, { headers: { "cache-control": "no-store" } });
}

/** POST { definition, schedule? }: saves a report. A schedule needs a relative period and emails the owner. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const withSchedule = body["schedule"] !== undefined && body["schedule"] !== null;
  const def = parseDefinition(body["definition"], staff, { scheduled: withSchedule });
  if (!def.ok) return fail(400, def.error);
  let schedule: { s: ReportSchedule; nextRunAt: string } | null = null;
  if (withSchedule) {
    const s = parseSchedule(body["schedule"]);
    if (!s.ok) return fail(400, s.error);
    schedule = { s: s.schedule, nextRunAt: nextRunAfter(s.schedule, new Date().toISOString()) };
  }
  const id = await createReport(getDb(), staff.id, def.definition, schedule);
  if (!id) return fail(409, "You have reached the limit of saved reports. Delete one first.");
  await staffAudit(staff, "saved_report", id, "staff.saved_report_created", { scheduled: schedule !== null, shared: def.definition.shared });
  return NextResponse.json({ id }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
