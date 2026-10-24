import { NextResponse } from "next/server";
import { planCaseResolve } from "../../../../../../src/domain/staff-admin";
import { getDb } from "../../../../../../src/server/context";
import { getCase, proposeResolve, resolveCase } from "../../../../../../src/server/staff-admin-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";

/**
 * Resolve a case with a required reason. Safety-gate cases (trust account, licence) are overrides:
 * the first call records the proposal (202), a different authorised person's call completes it and writes override_log.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Invalid JSON body.");
  const { id } = await ctx.params;
  const db = getDb();
  const c = UUID_RE.test(id) ? await getCase(db, id) : null;
  if (!c) return fail(404, "Case not found.");
  const plan = planCaseResolve(staff, c, body["reason"]);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  if (plan.action === "propose") {
    if (!(await proposeResolve(db, id, staff.id, plan.reason))) return fail(409, "This case changed; reload it.");
    await staffAudit(staff, "admin_case", id, "staff.case_override_proposed", { kind: c.kind });
    return NextResponse.json({ ok: true, pendingSecondPerson: true }, { status: 202 });
  }
  if (!(await resolveCase(db, c, staff.id, plan.reason, plan.override))) return fail(409, "This case is already resolved.");
  await staffAudit(staff, "admin_case", id, "staff.case_resolved", { kind: c.kind, override: plan.override !== null });
  return NextResponse.json({ ok: true });
}
