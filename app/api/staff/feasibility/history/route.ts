import { NextResponse } from "next/server";
import { parseHistory } from "../../../../../src/domain/feasibility";
import { getDb } from "../../../../../src/server/context";
import { addHistoryPg } from "../../../../../src/server/feasibility-db";
import { fail, readJsonObject, staffAudit, staffGateAny } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** Adds a finished project to the history: { name, points, weeks, outcome }. Entries cannot be edited or removed. Logged. */
async function handlePost(req: Request) {
  const staff = await staffGateAny(req, ["report.operations", "report.sales"]);
  if (staff instanceof NextResponse) return staff;
  const p = parseHistory(await readJsonObject(req));
  if (!p.ok) return fail(400, p.error);
  const id = await addHistoryPg(getDb(), p.value, staff.id);
  await staffAudit(staff, "project_history", id, "staff.project_history_added", { ...p.value });
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

export const POST = withApi(handlePost);
