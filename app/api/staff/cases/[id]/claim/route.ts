import { NextResponse } from "next/server";
import { planClaim } from "../../../../../../src/domain/staff-admin";
import { getDb } from "../../../../../../src/server/context";
import { claimCase, getCase } from "../../../../../../src/server/staff-admin-db";
import { fail, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "case.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  const db = getDb();
  const c = UUID_RE.test(id) ? await getCase(db, id) : null;
  if (!c) return fail(404, "Case not found.");
  const plan = planClaim(staff, c);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  if (!(await claimCase(db, id, staff.id))) return fail(409, "This case is already claimed.");
  await staffAudit(staff, "admin_case", id, "staff.case_claimed", { kind: c.kind });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(handlePost);
