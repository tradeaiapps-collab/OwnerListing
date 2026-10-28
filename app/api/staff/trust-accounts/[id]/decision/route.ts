import { NextResponse } from "next/server";
import { planTrustDecision } from "../../../../../../src/domain/staff-admin";
import { getDb } from "../../../../../../src/server/context";
import { finaliseTrustApproval, getTrustCheckState, recordTrustApproval, rejectTrustCheck } from "../../../../../../src/server/staff-admin-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../../src/server/staff-route";
import { withApi } from "../../../../../../src/server/api/with-api";

/** Approve or reject a trust account check (id is the check). New accounts and changed details need two different approvers. */
async function handlePost(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const staff = await staffGate(req, "trust_account.approve");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Invalid JSON body.");
  const { id } = await ctx.params;
  const db = getDb();
  const state = UUID_RE.test(id) ? await getTrustCheckState(db, id) : null;
  if (!state) return fail(404, "Check not found.");
  const reason = body["reason"];
  const plan = planTrustDecision(staff, state, body["outcome"], reason);
  if (plan.action === "deny") return fail(plan.status, plan.error);
  const text = (reason as string).trim();
  try {
    if (plan.action === "reject") await rejectTrustCheck(db, id, staff.id, text);
    else if (plan.action === "approve") await finaliseTrustApproval(db, id, staff.id, text);
    else await recordTrustApproval(db, id, staff.id, text);
  } catch {
    return fail(409, "This check changed or you already decided on it; reload.");
  }
  const outcome = plan.action === "reject" ? "rejected" : plan.action === "approve" ? "approved" : "first_approval";
  await staffAudit(staff, "trust_account_check", id, `staff.trust_account_${outcome}`, {});
  return NextResponse.json({ ok: true, outcome, pendingSecondPerson: outcome === "first_approval" });
}

export const POST = withApi(handlePost);
