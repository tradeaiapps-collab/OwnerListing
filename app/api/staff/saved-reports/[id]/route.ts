import { NextResponse } from "next/server";
import { describeSchedule, nextRunAfter, parseDefinition, parseSchedule, type ReportSchedule } from "../../../../../src/domain/saved-reports";
import { getDb } from "../../../../../src/server/context";
import { archiveReport, clearSchedule, getReport, listRuns, setSchedule, updateReport } from "../../../../../src/server/saved-reports-db";
import { canOpen, forViewer } from "../../../../../src/server/saved-reports-route";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** GET: one report. The owner also gets the schedule and the stored run history. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Report not found.");
  const db = getDb();
  const row = await getReport(db, id);
  if (!row || !canOpen(row, staff)) return fail(404, "Report not found.");
  const mine = row.ownerUserId === staff.id;
  const definition = mine ? row.definition : forViewer(row.definition, staff);
  if (!definition) return fail(404, "Report not found.");
  return NextResponse.json({
    report: { id: row.id, mine, definition, shared: row.shared, schedule: mine && row.schedule ? { ...row.schedule, description: describeSchedule(row.schedule) } : null },
    runs: mine ? await listRuns(db, id) : []
  }, { headers: { "cache-control": "no-store" } });
}

/** PATCH { definition?, schedule? }: owner only. schedule null stops the schedule; an object sets or replaces it. */
async function handlePatch(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Report not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const db = getDb();
  const row = await getReport(db, id);
  if (!row || row.ownerUserId !== staff.id) return fail(404, "Report not found.");
  const scheduleIn = body["schedule"];
  const willBeScheduled = scheduleIn === undefined ? row.schedule !== null : scheduleIn !== null;
  const defIn = body["definition"] ?? row.definition;
  const def = parseDefinition(defIn, staff, { scheduled: willBeScheduled });
  if (!def.ok) return fail(400, def.error);
  let schedule: ReportSchedule | null = null;
  if (scheduleIn !== undefined && scheduleIn !== null) {
    const s = parseSchedule(scheduleIn);
    if (!s.ok) return fail(400, s.error);
    schedule = s.schedule;
  }
  if (!(await updateReport(db, id, staff.id, def.definition))) return fail(404, "Report not found.");
  if (schedule) await setSchedule(db, id, schedule, nextRunAfter(schedule, new Date().toISOString()));
  else if (scheduleIn === null) await clearSchedule(db, id);
  await staffAudit(staff, "saved_report", id, "staff.saved_report_updated", { scheduled: willBeScheduled, shared: def.definition.shared });
  return NextResponse.json({ ok: true });
}

/** DELETE: owner only. The report leaves the list and its schedule stops; history stays for the audit trail. */
async function handleDelete(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Report not found.");
  if (!(await archiveReport(getDb(), id, staff.id))) return fail(404, "Report not found.");
  await staffAudit(staff, "saved_report", id, "staff.saved_report_deleted", {});
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGet);
export const PATCH = withApi(handlePatch);
export const DELETE = withApi(handleDelete);
