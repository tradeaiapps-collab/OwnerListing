import { NextResponse } from "next/server";
import { planUserAction } from "../../../../../../src/domain/admin-moderation";
import { getDb } from "../../../../../../src/server/context";
import { setUserStatus, userTarget } from "../../../../../../src/server/admin-moderation-db";
import { fail, readJsonObject, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";

type Ctx = { params: Promise<{ id: string }> };

/** Body { action: "suspend" | "reinstate", reason }. A suspended account is refused from its next request. Audited with the change. */
export async function POST(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "user.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Account not found.");
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const db = getDb();
  const target = await userTarget(db, id);
  if (!target) return fail(404, "Account not found.");
  const plan = planUserAction(staff, target, body["action"], body["reason"]);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  if (!(await setUserStatus(db, staff, id, plan.from, plan.to, plan.reason))) return fail(409, "This account changed in the meantime. Reload and try again.");
  return NextResponse.json({ ok: true, status: plan.to });
}
