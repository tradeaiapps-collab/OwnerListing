import { NextResponse } from "next/server";
import { parseRule, TRIGGER_INFO, describeRule } from "../../../../src/domain/automation";
import { describeTask, parseTask, TASK_INFO } from "../../../../src/domain/scheduled-tasks";
import { createRulePg, listRulesPg, recentRunsPg } from "../../../../src/server/automation-db";
import { getDb, getDeps } from "../../../../src/server/context";
import { createTaskPg, listTasksPg, recentTaskRunsPg } from "../../../../src/server/scheduled-tasks-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Workflow rules, scheduled tasks and their recent runs (one screen, /staff/automation). */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "automation.manage");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const [rules, runs, tasks, taskRuns] = await Promise.all([listRulesPg(db), recentRunsPg(db), listTasksPg(db), recentTaskRunsPg(db)]);
  return NextResponse.json({
    rules: rules.map(r => ({ ...r, summary: describeRule(r) })), runs,
    tasks: tasks.map(t => ({ ...t, summary: describeTask(t) })), taskRuns,
    triggers: TRIGGER_INFO, taskKinds: TASK_INFO
  }, { headers: { "cache-control": "no-store" } });
}

/** Create a rule ({ resource: "rule", name, trigger, triggerConfig, recipient, messageKind, title, body, link }) or a scheduled task ({ resource: "task", name, kind, config, cadence, hour, weekday, dayOfMonth, runAt }). */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "automation.manage");
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  if (!b) return fail(400, "Send a JSON body.");
  const now = getDeps().now();
  if (b["resource"] === "task") {
    const p = parseTask(b, now);
    if (!p.ok) return fail(400, p.error);
    const id = await createTaskPg(getDb(), p.value, staff.id, now);
    await staffAudit(staff, "scheduled_task", id, "staff.scheduled_task_created", { kind: p.value.kind, cadence: p.value.cadence });
    return NextResponse.json({ ok: true, id }, { status: 201 });
  }
  const p = parseRule(b);
  if (!p.ok) return fail(400, p.error);
  const id = await createRulePg(getDb(), p.rule, staff.id);
  await staffAudit(staff, "automation_rule", id, "staff.automation_rule_created", { trigger: p.rule.trigger, recipient: p.rule.recipient, enabled: p.rule.enabled });
  return NextResponse.json({ ok: true, id }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
