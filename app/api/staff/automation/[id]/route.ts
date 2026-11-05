import { NextResponse } from "next/server";
import { parseRule } from "../../../../../src/domain/automation";
import { deleteRulePg, getRulePg, setRuleEnabledPg, updateRulePg } from "../../../../../src/server/automation-db";
import { getDb, getDeps } from "../../../../../src/server/context";
import { deleteTaskPg, runTaskNowPg, setTaskEnabledPg } from "../../../../../src/server/scheduled-tasks-db";
import { fail, readJsonObject, staffAudit, staffGate, UUID_RE } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

type Ctx = { params: Promise<{ id: string }> };
const resourceOf = (req: Request) => (new URL(req.url).searchParams.get("resource") === "task" ? "task" : "rule");

/**
 * ?resource=rule (default) body { action: "enable" | "disable" } or a full rule to replace it;
 * ?resource=task body { action: "enable" | "disable" | "run" } (run = run once now; the schedule is unchanged).
 */
async function handlePatch(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "automation.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const b = await readJsonObject(req);
  if (!b) return fail(400, "Send a JSON body.");
  const db = getDb(), now = getDeps().now();
  const action = b["action"];
  if (resourceOf(req) === "task") {
    if (action === "run") {
      if (!(await runTaskNowPg(db, id, now, process.env))) return fail(404, "Task not found.");
      await staffAudit(staff, "scheduled_task", id, "staff.scheduled_task_run_now", {});
      return NextResponse.json({ ok: true });
    }
    if (action !== "enable" && action !== "disable") return fail(400, "Choose enable, disable or run.");
    if (!(await setTaskEnabledPg(db, id, action === "enable", now))) return fail(404, "Task not found.");
    await staffAudit(staff, "scheduled_task", id, `staff.scheduled_task_${action}d`, {});
    return NextResponse.json({ ok: true });
  }
  if (action === "enable" || action === "disable") {
    if (!(await setRuleEnabledPg(db, id, action === "enable"))) return fail(404, "Rule not found.");
    await staffAudit(staff, "automation_rule", id, `staff.automation_rule_${action}d`, {});
    return NextResponse.json({ ok: true });
  }
  const p = parseRule(b);
  if (!p.ok) return fail(400, p.error);
  if (!(await getRulePg(db, id))) return fail(404, "Rule not found.");
  await updateRulePg(db, id, p.rule);
  await staffAudit(staff, "automation_rule", id, "staff.automation_rule_updated", { trigger: p.rule.trigger, recipient: p.rule.recipient });
  return NextResponse.json({ ok: true });
}

/** Remove a rule or task that never ran; one that has run is switched off instead so its history stays. */
async function handleDelete(req: Request, { params }: Ctx) {
  const staff = await staffGate(req, "automation.manage");
  if (staff instanceof NextResponse) return staff;
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Not found.");
  const task = resourceOf(req) === "task";
  const r = task ? await deleteTaskPg(getDb(), id, getDeps().now()) : await deleteRulePg(getDb(), id);
  if (r === "missing") return fail(404, "Not found.");
  await staffAudit(staff, task ? "scheduled_task" : "automation_rule", id, task ? "staff.scheduled_task_removed" : "staff.automation_rule_removed", { result: r });
  return NextResponse.json({ ok: true, result: r });
}

export const PATCH = withApi(handlePatch);
export const DELETE = withApi(handleDelete);
