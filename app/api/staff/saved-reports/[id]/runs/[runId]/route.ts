import { NextResponse } from "next/server";
import { getDb } from "../../../../../../../src/server/context";
import { getReport, getRun } from "../../../../../../../src/server/saved-reports-db";
import { fail, staffGate, UUID_RE } from "../../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/** One stored run of a report. Owner only: a snapshot was built with the owner's permissions, so nobody else sees it. */
async function handleGet(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  const { id, runId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(runId)) return fail(404, "Run not found.");
  const db = getDb();
  const row = await getReport(db, id);
  if (!row || row.ownerUserId !== staff.id) return fail(404, "Run not found.");
  const run = await getRun(db, id, runId);
  return run ? NextResponse.json(run, { headers: { "cache-control": "no-store" } }) : fail(404, "Run not found.");
}

export const GET = withApi(handleGet);
