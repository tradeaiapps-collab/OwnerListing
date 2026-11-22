import { NextResponse } from "next/server";
import { parseVerificationDecision } from "../../../../../../src/domain/contractor-trust";
import { getDb } from "../../../../../../src/server/context";
import { logOutcomePg } from "../../../../../../src/server/elena-prescreen-db";
import { decideVerificationPg } from "../../../../../../src/server/contractor-trust-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };

/** { "action": "verify" | "reject", "note"?: text }. Staff compare what the contractor supplied against the real certificates; nothing is looked up automatically. */
async function handlePost(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "licence.verify");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const d = parseVerificationDecision(await readJsonObject(req));
  if (!d.ok) return fail(400, d.message);
  const db = getDb();
  // The outcome log runs inside the decision's transaction: both commit, or neither.
  if (!(await decideVerificationPg(db, id, staff.id, d.value.action, d.value.note, undefined,
    tx => logOutcomePg(tx, { queue: "verification", subjectId: id, staffId: staff.id, staffRole: staff.role, staffAction: d.value.action === "verify" ? "verify" : "needs_info" })))) return fail(409, "Already decided, not found, or this is your own account.");
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
