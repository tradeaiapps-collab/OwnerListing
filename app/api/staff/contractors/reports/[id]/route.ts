import { NextResponse } from "next/server";
import { parseReportDecision } from "../../../../../../src/domain/contractor-trust";
import { getDb } from "../../../../../../src/server/context";
import { logOutcomePg } from "../../../../../../src/server/elena-prescreen-db";
import { decideReportPg } from "../../../../../../src/server/contractor-trust-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** { "action": "dismiss" | "uphold" | "uphold_and_suspend", "note": text }. Decided once; suspension is in the same step. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "moderation.review");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const d = parseReportDecision(await readJsonObject(req));
  if (!d.ok) return fail(400, d.message);
  const db = getDb();
  // The outcome log runs inside the decision's transaction (suspension included): all commit, or none.
  if ((await decideReportPg(db, id, staff.id, d.value.action, d.value.note,
    tx => logOutcomePg(tx, { queue: "complaint", subjectId: id, staffId: staff.id, staffRole: staff.role, staffAction: d.value.action }))) !== "ok") return fail(409, "Already decided, not found, or you are a party to it.");
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
