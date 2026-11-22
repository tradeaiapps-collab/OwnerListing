import { NextResponse } from "next/server";
import { parseAction } from "../../../../../src/domain/staff-project";
import { staffCan } from "../../../../../src/domain/staff-access";
import { getDb } from "../../../../../src/server/context";
import { act, decide, projectDetail } from "../../../../../src/server/staff-project-db";
import { fail, readJsonObject, staffAudit, staffGateAny, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

const ANY = ["project.manage", "project.review", "project.tech_lead"] as const;
type Ctx = { params: Promise<{ id: string }> };

/** One project: feasibility, risk flags, approvals, milestones, features and linked PRs. */
async function handleGet(req: Request, ctx: Ctx) {
  const staff = await staffGateAny(req, ANY);
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(404, "Project not found.");
  const r = await projectDetail(getDb(), id);
  if (!r.ok) return fail(r.status, r.error);
  return NextResponse.json({
    project: r.value,
    can: { manage: staffCan(staff, "project.manage"), techLead: staffCan(staff, "project.tech_lead"), review: staffCan(staff, "project.review"), self: staff.id }
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * { action: "decide", as: "tech_lead" | "stakeholder", decision, comments } needs the matching permission and is never the proposer or owner.
 * Every other action (milestone_add, milestone_done, feature_add, feature_status, pr_link, pr_status, block, unblock, note, set_status) needs project.manage.
 */
async function handlePost(req: Request, ctx: Ctx) {
  const staff = await staffGateAny(req, ANY);
  if (staff instanceof NextResponse) return staff;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return fail(404, "Project not found.");
  const a = parseAction(await readJsonObject(req));
  if (!a.ok) return fail(400, a.error);
  const db = getDb();
  if (a.value.action === "decide") {
    const d = a.value.value;
    const r = await decide(db, { id: staff.id, canTechLead: staffCan(staff, "project.tech_lead"), canReview: staffCan(staff, "project.review") }, id, d);
    if (!r.ok) return fail(r.status, r.error);
    await staffAudit(staff, "staff_project", id, "staff.project_decision", { as: d.as, decision: d.decision, resultingStatus: r.value.status });
    return NextResponse.json({ ok: true, status: r.value.status });
  }
  if (!staffCan(staff, "project.manage")) return fail(403, "Not allowed.");
  const r = await act(db, staff.id, id, a.value);
  if (!r.ok) return fail(r.status, r.error);
  await staffAudit(staff, "staff_project", id, `staff.project_${a.value.action}`, { ...("name" in a.value ? { name: a.value.name } : {}), ...("prNumber" in a.value ? { prNumber: a.value.prNumber } : {}), ...("status" in a.value ? { status: a.value.status } : {}) });
  return NextResponse.json({ ok: true });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
