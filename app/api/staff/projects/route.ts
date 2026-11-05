import { NextResponse } from "next/server";
import { PROJECT_STATUSES, parseProposal, computeRisks } from "../../../../src/domain/staff-project";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb } from "../../../../src/server/context";
import { createProject, getSettings, listPeople, listProjects, setHighBudget } from "../../../../src/server/staff-project-db";
import { fail, readJsonObject, staffAudit, staffGate, staffGateAny, UUID_RE } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const ANY = ["project.manage", "project.review", "project.tech_lead"] as const;

/** All projects (waiting, then stuck, blocked and at risk first), plus the staff list and the high-budget threshold. Filters: ?status= ?owner= ?goal= */
async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ANY);
  if (staff instanceof NextResponse) return staff;
  const q = new URL(req.url).searchParams, status = q.get("status"), owner = q.get("owner"), goal = q.get("goal");
  if (status && !(PROJECT_STATUSES as readonly string[]).includes(status)) return fail(400, "Unknown status.");
  if (owner && !UUID_RE.test(owner)) return fail(400, "Unknown owner.");
  const db = getDb();
  const { projects, escalatedNow } = await listProjects(db, { ...(status ? { status } : {}), ...(owner ? { ownerId: owner } : {}), ...(goal ? { goal: goal.slice(0, 100) } : {}) });
  for (const id of escalatedNow) await staffAudit(staff, "staff_project", id, "staff.project_escalated", { reason: "no progress for more than 5 days" });
  return NextResponse.json({
    projects, people: await listPeople(db), settings: await getSettings(db),
    can: { propose: staffCan(staff, "project.manage"), configure: staffCan(staff, "config.edit") }
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * Submits a proposal (project.manage): { title, description, goal, ownerId, memberIds, startDate, endDate, budgetDollars, storyPoints,
 * estimatedHours, estimatedDays, teamSize, usesNewTech, systemsAffected, assumptions, unknowns, checklist }. Risk flags are computed here.
 * Or { action: "preview" } with the same fields to see the flags without saving. Or { action: "set_threshold", highBudgetDollars } (config.edit).
 */
async function handlePost(req: Request) {
  const staff = await staffGateAny(req, ANY);
  if (staff instanceof NextResponse) return staff;
  const b = await readJsonObject(req);
  if (b?.["action"] === "set_threshold") {
    if (!staffCan(staff, "config.edit")) return fail(403, "Not allowed.");
    const d = b["highBudgetDollars"];
    if (typeof d !== "number" || !Number.isFinite(d) || d < 1 || d > 100_000_000) return fail(400, "The threshold must be a dollar amount of 1 or more.");
    await setHighBudget(getDb(), staff.id, Math.round(d * 100));
    await staffAudit(staff, "staff_project_settings", "singleton", "staff.project_threshold_set", { highBudgetCents: Math.round(d * 100) });
    return NextResponse.json({ ok: true });
  }
  if (!staffCan(staff, "project.manage")) return fail(403, "Not allowed.");
  const p = parseProposal(b);
  if (!p.ok) return fail(400, p.error);
  if (b?.["action"] === "preview") return NextResponse.json({ risks: computeRisks(p.value, (await getSettings(getDb())).highBudgetCents) });
  const r = await createProject(getDb(), staff.id, p.value);
  if (!r.ok) return fail(r.status, r.error);
  await staffAudit(staff, "staff_project", r.value.id, "staff.project_proposed", { title: p.value.title, ownerId: p.value.ownerId, budgetCents: p.value.budgetCents, risks: r.value.risks.map(x => x.type) });
  return NextResponse.json({ ok: true, id: r.value.id, risks: r.value.risks }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
