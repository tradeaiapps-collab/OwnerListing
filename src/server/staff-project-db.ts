import { randomUUID } from "node:crypto";
import {
  approvalOutcome, computeRisks, feasibility, featureSummary, mayDecide, projectHealth,
  type ApprovalRow, type Checklist, type DecideInput, type FeatureStatus, type HealthInfo, type MilestoneInput, type MilestoneRow,
  type Phase, type PrStatus, type ProjectAction, type ProposalInput, type RiskFlag, type Severity
} from "../domain/staff-project";
import type { Queryable } from "./db";
import { notifyUser } from "./notifier";

// Parameterised SQL only. Each write that touches several rows runs in one transaction with the project row locked first.

export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const day = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export interface Person { id: string; name: string; role: string }
export interface ProjectCard {
  id: string; title: string; goal: string; status: string; ownerId: string; ownerName: string; memberNames: string[];
  startDate: string; endDate: string; budgetCents: number; health: HealthInfo; blockedReason: string | null; escalatedAt: string | null;
  prs: { merged: number; open: number; total: number }; featureLine: string; riskCount: number; createdAt: string;
}
export interface ProjectDetail extends ProjectCard {
  description: string; storyPoints: number; estimatedHours: number; estimatedDays: number; teamSize: number; usesNewTech: boolean; systemsAffected: number;
  assumptions: string; unknowns: string; checklist: Checklist; createdBy: string; approvedAt: string | null; approvedByName: string | null;
  feasibility: ReturnType<typeof feasibility>; risks: RiskFlag[]; milestones: MilestoneRow[];
  approvals: { approverName: string; role: string; decision: string; comments: string; at: string }[];
  prList: { prNumber: number; title: string; status: PrStatus; mergedAt: string | null }[];
  featureList: { id: string; name: string; status: FeatureStatus }[];
  needs: { techLead: boolean; stakeholder: boolean };
}
export interface Settings { highBudgetCents: number }

export async function getSettings(db: Queryable): Promise<Settings> {
  const r = (await db.query("SELECT high_budget_cents FROM staff_project_settings WHERE id")).rows[0];
  return { highBudgetCents: Number(r?.["high_budget_cents"] ?? 5_000_000) };
}
export async function setHighBudget(db: Queryable, staffId: string, cents: number): Promise<void> {
  await db.query("UPDATE staff_project_settings SET high_budget_cents = $1, updated_by = $2::uuid, updated_at = now() WHERE id", [cents, staffId]);
}

/** Active staff (accepted, not revoked), for the owner and team pickers. */
export async function listPeople(db: Queryable): Promise<Person[]> {
  const r = await db.query(
    `SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.email) AS name, i.role
       FROM staff_invite i JOIN app_user u ON lower(u.email) = i.email
      WHERE i.revoked_at IS NULL AND i.accepted_at IS NOT NULL ORDER BY name`);
  return r.rows.map(x => ({ id: String(x["id"]), name: String(x["name"]), role: String(x["role"]) }));
}

async function tell(db: Queryable, userId: string, title: string, text: string): Promise<void> {
  try { await notifyUser(db, userId, "system_notice", { title, text }); } catch { /* a notification never blocks the project step */ }
}

export async function createProject(db: Queryable, staffId: string, p: ProposalInput): Promise<Out<{ id: string; risks: RiskFlag[] }>> {
  const settings = await getSettings(db);
  const risks = computeRisks(p, settings.highBudgetCents);
  const people = new Set([p.ownerId, ...p.memberIds]);
  const known = await db.query("SELECT id FROM app_user WHERE id = ANY($1::uuid[]) AND status = 'active'", [[...people]]);
  const staff = new Set((await listPeople(db)).map(x => x.id));
  if (known.rows.length !== people.size || [...people].some(id => !staff.has(id))) return no(400, "The owner and team members must be active staff.");
  const id = randomUUID();
  await atomic(db, async tx => {
    await tx.query(
      `INSERT INTO staff_project (id, title, description, goal, owner_id, start_date, end_date, budget_cents, story_points, estimated_hours, estimated_days, team_size,
                                  uses_new_tech, systems_affected, assumptions, unknowns, checklist, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)`,
      [id, p.title, p.description, p.goal, p.ownerId, p.startDate, p.endDate, p.budgetCents, p.storyPoints, p.estimatedHours, p.estimatedDays, p.teamSize,
       p.usesNewTech, p.systemsAffected, p.assumptions, p.unknowns, JSON.stringify(p.checklist), staffId]);
    for (const m of p.memberIds) await tx.query("INSERT INTO staff_project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id, m]);
    for (const r of risks) await tx.query("INSERT INTO staff_project_risk_flags (project_id, risk_type, severity, description) VALUES ($1,$2,$3,$4)", [id, r.type, r.severity, r.description]);
  });
  return { ok: true, value: { id, risks } };
}

const CARD_SQL =
  `SELECT p.*, to_char(p.start_date,'YYYY-MM-DD') AS start_day, to_char(p.end_date,'YYYY-MM-DD') AS end_day,
          COALESCE(NULLIF(o.display_name,''), o.email) AS owner_name,
          COALESCE((SELECT array_agg(COALESCE(NULLIF(u.display_name,''), u.email) ORDER BY u.display_name) FROM staff_project_members m JOIN app_user u ON u.id = m.user_id WHERE m.project_id = p.id), '{}') AS member_names,
          (SELECT count(*) FROM staff_project_risk_flags f WHERE f.project_id = p.id) AS risk_count
     FROM staff_project p JOIN app_user o ON o.id = p.owner_id`;

const milestonesFor = async (db: Queryable, ids: string[]): Promise<Map<string, MilestoneRow[]>> => {
  const out = new Map<string, MilestoneRow[]>();
  if (!ids.length) return out;
  const r = await db.query(`SELECT id, project_id, phase, description, to_char(target_date,'YYYY-MM-DD') AS target, to_char(actual_date,'YYYY-MM-DD') AS actual FROM staff_project_milestones WHERE project_id = ANY($1::uuid[]) ORDER BY target_date, created_at`, [ids]);
  for (const x of r.rows) {
    const k = String(x["project_id"]);
    (out.get(k) ?? out.set(k, []).get(k)!).push({ id: String(x["id"]), phase: String(x["phase"]) as Phase, description: String(x["description"]), targetDate: String(x["target"]), actualDate: x["actual"] == null ? null : String(x["actual"]) });
  }
  return out;
};

function card(r: Record<string, unknown>, milestones: MilestoneRow[], prs: { merged: number; open: number; total: number }, features: { status: FeatureStatus }[], now: Date): ProjectCard {
  const health = projectHealth({ status: String(r["status"]), startDate: String(r["start_day"]), endDate: String(r["end_day"]), blockedReason: r["blocked_reason"] == null ? null : String(r["blocked_reason"]), lastProgressAt: iso(r["last_progress_at"])! }, milestones, now);
  return {
    id: String(r["id"]), title: String(r["title"]), goal: String(r["goal"]), status: String(r["status"]), ownerId: String(r["owner_id"]), ownerName: String(r["owner_name"]),
    memberNames: (r["member_names"] as string[]) ?? [], startDate: String(r["start_day"]), endDate: String(r["end_day"]), budgetCents: Number(r["budget_cents"]), health,
    blockedReason: r["blocked_reason"] == null ? null : String(r["blocked_reason"]), escalatedAt: iso(r["escalated_at"]), prs, featureLine: featureSummary(features),
    riskCount: Number(r["risk_count"]), createdAt: iso(r["created_at"])!
  };
}

export interface ListFilter { status?: string; ownerId?: string; goal?: string }

/**
 * All projects, newest first (stuck ones first). Any active project with no progress for more than 5 days is escalated here, once:
 * the escalation time is stored, the CTO-level staff (super admin, technical) are notified, and the caller gets the ids to audit.
 */
export async function listProjects(db: Queryable, f: ListFilter = {}, now: Date = new Date()): Promise<{ projects: ProjectCard[]; escalatedNow: string[] }> {
  const r = await db.query(`${CARD_SQL} WHERE ($1::text IS NULL OR p.status = $1) AND ($2::uuid IS NULL OR p.owner_id = $2::uuid) AND ($3::text IS NULL OR p.goal ILIKE '%' || $3 || '%') ORDER BY p.created_at DESC LIMIT 500`,
    [f.status ?? null, f.ownerId ?? null, f.goal ? f.goal.replace(/[%_\\]/g, "\\$&") : null]);
  const ids = r.rows.map(x => String(x["id"]));
  const ms = await milestonesFor(db, ids);
  const prs = new Map<string, { merged: number; open: number; total: number }>(), feats = new Map<string, { status: FeatureStatus }[]>();
  if (ids.length) {
    for (const x of (await db.query("SELECT project_id, count(*) FILTER (WHERE status = 'merged') AS merged, count(*) FILTER (WHERE status IN ('draft','open','needs_review')) AS open, count(*) AS total FROM staff_project_prs WHERE project_id = ANY($1::uuid[]) GROUP BY project_id", [ids])).rows)
      prs.set(String(x["project_id"]), { merged: Number(x["merged"]), open: Number(x["open"]), total: Number(x["total"]) });
    for (const x of (await db.query("SELECT project_id, status FROM staff_project_features WHERE project_id = ANY($1::uuid[])", [ids])).rows)
      (feats.get(String(x["project_id"])) ?? feats.set(String(x["project_id"]), []).get(String(x["project_id"]))!).push({ status: String(x["status"]) as FeatureStatus });
  }
  const projects = r.rows.map(x => card(x, ms.get(String(x["id"])) ?? [], prs.get(String(x["id"])) ?? { merged: 0, open: 0, total: 0 }, feats.get(String(x["id"])) ?? [], now));
  const escalatedNow: string[] = [];
  for (const p of projects) {
    if (!p.health.escalate || p.escalatedAt) continue;
    const u = await db.query("UPDATE staff_project SET escalated_at = $2::timestamptz WHERE id = $1::uuid AND escalated_at IS NULL RETURNING id", [p.id, now.toISOString()]);
    if (!u.rows.length) continue;
    p.escalatedAt = now.toISOString(); escalatedNow.push(p.id);
    const cto = await db.query(`SELECT u.id FROM staff_invite i JOIN app_user u ON lower(u.email) = i.email WHERE i.revoked_at IS NULL AND i.accepted_at IS NOT NULL AND i.role IN ('super_admin','technical')`);
    for (const c of cto.rows) await tell(db, String(c["id"]), "Project stuck", `"${p.title}" has had no progress for ${p.health.stuckDays} days. Open it at /staff/projects/${p.id}.`);
  }
  const rank = (p: ProjectCard) => (p.status === "pending_approval" ? 0 : p.health.escalate ? 1 : p.health.health === "blocked" ? 2 : p.health.health === "at_risk" ? 3 : 4);
  projects.sort((a, b) => rank(a) - rank(b));
  return { projects, escalatedNow };
}

export async function projectDetail(db: Queryable, id: string, now: Date = new Date()): Promise<Out<ProjectDetail>> {
  const r = (await db.query(`${CARD_SQL} WHERE p.id = $1::uuid`, [id])).rows[0];
  if (!r) return no(404, "Project not found.");
  const ms = (await milestonesFor(db, [id])).get(id) ?? [];
  const [prRows, featRows, riskRows, apRows] = await Promise.all([
    db.query("SELECT pr_number, pr_title, status, merged_at FROM staff_project_prs WHERE project_id = $1::uuid ORDER BY pr_number", [id]),
    db.query("SELECT id, feature_name, status FROM staff_project_features WHERE project_id = $1::uuid ORDER BY feature_name", [id]),
    db.query("SELECT risk_type, severity, description FROM staff_project_risk_flags WHERE project_id = $1::uuid ORDER BY risk_type", [id]),
    db.query(`SELECT a.approver_id, a.role, a.decision, a.comments, a.approved_at, COALESCE(NULLIF(u.display_name,''), u.email) AS name FROM staff_project_approvals a JOIN app_user u ON u.id = a.approver_id WHERE a.project_id = $1::uuid ORDER BY a.approved_at`, [id])
  ]);
  const prList = prRows.rows.map(x => ({ prNumber: Number(x["pr_number"]), title: String(x["pr_title"]), status: String(x["status"]) as PrStatus, mergedAt: iso(x["merged_at"]) }));
  const featureList = featRows.rows.map(x => ({ id: String(x["id"]), name: String(x["feature_name"]), status: String(x["status"]) as FeatureStatus }));
  const base = card(r, ms, { merged: prList.filter(x => x.status === "merged").length, open: prList.filter(x => ["draft", "open", "needs_review"].includes(x.status)).length, total: prList.length }, featureList, now);
  const checklist = r["checklist"] as Checklist;
  const input = { checklist, storyPoints: Number(r["story_points"]), estimatedHours: Number(r["estimated_hours"]), estimatedDays: Number(r["estimated_days"]), teamSize: Number(r["team_size"]), assumptions: String(r["assumptions"]), unknowns: String(r["unknowns"]) };
  const rows: ApprovalRow[] = apRows.rows.map(x => ({ approverId: String(x["approver_id"]), role: String(x["role"]) as ApprovalRow["role"], decision: String(x["decision"]) as ApprovalRow["decision"] }));
  const o = approvalOutcome(rows);
  const approver = r["approved_by_id"] == null ? null : (await db.query("SELECT COALESCE(NULLIF(display_name,''), email) AS name FROM app_user WHERE id = $1::uuid", [String(r["approved_by_id"])])).rows[0];
  return { ok: true, value: {
    ...base, description: String(r["description"]), ...input, usesNewTech: r["uses_new_tech"] === true, systemsAffected: Number(r["systems_affected"]), createdBy: String(r["created_by"]),
    approvedAt: iso(r["approved_at"]), approvedByName: approver ? String(approver["name"]) : null, feasibility: feasibility(input),
    risks: riskRows.rows.map(x => ({ type: String(x["risk_type"]) as RiskFlag["type"], severity: String(x["severity"]) as Severity, description: String(x["description"]) })),
    milestones: ms, prList, featureList, needs: { techLead: o.needsTechLead, stakeholder: o.needsStakeholder },
    approvals: apRows.rows.map(x => ({ approverName: String(x["name"]), role: String(x["role"]), decision: String(x["decision"]), comments: String(x["comments"]), at: iso(x["approved_at"])! }))
  } };
}

/** Records one approval or rejection. When the rules are met the project goes active; a rejection closes it. The owner is told either way. */
export async function decide(db: Queryable, actor: { id: string; canTechLead: boolean; canReview: boolean }, id: string, d: DecideInput, now: Date = new Date()): Promise<Out<{ status: string }>> {
  const res = await atomic(db, async tx => {
    const p = (await tx.query("SELECT status, created_by, owner_id, title FROM staff_project WHERE id = $1::uuid FOR UPDATE", [id])).rows[0];
    if (!p) return no(404, "Project not found.");
    const rows: ApprovalRow[] = (await tx.query("SELECT approver_id, role, decision FROM staff_project_approvals WHERE project_id = $1::uuid", [id])).rows
      .map(x => ({ approverId: String(x["approver_id"]), role: String(x["role"]) as ApprovalRow["role"], decision: String(x["decision"]) as ApprovalRow["decision"] }));
    const ok = mayDecide({ actorId: actor.id, canTechLead: actor.canTechLead, canReview: actor.canReview }, { status: String(p["status"]), createdBy: String(p["created_by"]), ownerId: String(p["owner_id"]) }, rows, d);
    if (!ok.ok) return ok;
    await tx.query("INSERT INTO staff_project_approvals (project_id, approver_id, role, decision, comments) VALUES ($1,$2,$3,$4,$5)", [id, actor.id, d.as, d.decision, d.comments]);
    const o = approvalOutcome([...rows, { approverId: actor.id, role: d.as, decision: d.decision }]);
    if (o.outcome === "approved") await tx.query("UPDATE staff_project SET status = 'active', decided_at = $2::timestamptz, approved_at = $2::timestamptz, approved_by_id = $3::uuid, last_progress_at = $2::timestamptz, updated_at = now() WHERE id = $1::uuid", [id, now.toISOString(), actor.id]);
    else if (o.outcome === "rejected") await tx.query("UPDATE staff_project SET status = 'rejected', decided_at = $2::timestamptz, updated_at = now() WHERE id = $1::uuid", [id, now.toISOString()]);
    return { ok: true as const, value: { status: o.outcome === "approved" ? "active" : o.outcome === "rejected" ? "rejected" : "pending_approval", ownerId: String(p["owner_id"]), title: String(p["title"]) } };
  });
  if (!res.ok) return res;
  const { status, ownerId, title } = res.value;
  if (status === "active") await tell(db, ownerId, "Project approved", `"${title}" is approved and now active. Open it at /staff/projects/${id}.`);
  if (status === "rejected") await tell(db, ownerId, "Project not approved", `"${title}" was not approved. Comment: ${d.comments.slice(0, 200)}. See /staff/projects/${id}.`);
  return { ok: true, value: { status } };
}

/** The non-approval actions. All need the project to be live or waiting (not rejected), and all count as progress. */
export async function act(db: Queryable, staffId: string, id: string, a: Exclude<ProjectAction, { action: "decide" }>, now: Date = new Date()): Promise<Out<{ ok: true }>> {
  return atomic(db, async tx => {
    const p = (await tx.query("SELECT status FROM staff_project WHERE id = $1::uuid FOR UPDATE", [id])).rows[0];
    if (!p) return no(404, "Project not found.");
    const status = String(p["status"]);
    if (status === "rejected") return no(409, "A rejected project cannot be changed. Make a new proposal.");
    if (status === "completed" && a.action !== "note") return no(409, "A completed project cannot be changed.");
    const live = status === "active" || status === "on_hold";
    if (!live && !["milestone_add", "feature_add", "note"].includes(a.action)) return no(409, "That step is available once the project is approved.");
    const touch = () => tx.query("UPDATE staff_project SET last_progress_at = $2::timestamptz, escalated_at = NULL, updated_at = now() WHERE id = $1::uuid", [id, now.toISOString()]);
    switch (a.action) {
      case "milestone_add": {
        const m: MilestoneInput = a.value;
        await tx.query("INSERT INTO staff_project_milestones (project_id, phase, description, target_date) VALUES ($1,$2,$3,$4::date)", [id, m.phase, m.description, m.targetDate]);
        break;
      }
      case "milestone_done": {
        const u = await tx.query("UPDATE staff_project_milestones SET actual_date = $3::date WHERE id = $1::uuid AND project_id = $2::uuid RETURNING id", [a.id, id, a.actualDate]);
        if (!u.rows.length) return no(404, "Milestone not found.");
        break;
      }
      case "feature_add": {
        const u = await tx.query("INSERT INTO staff_project_features (project_id, feature_name, status) VALUES ($1,$2,$3) ON CONFLICT (project_id, feature_name) DO NOTHING RETURNING id", [id, a.name, a.status]);
        if (!u.rows.length) return no(409, "That feature is already on this project.");
        break;
      }
      case "feature_status": {
        const u = await tx.query("UPDATE staff_project_features SET status = $3, updated_at = now() WHERE id = $1::uuid AND project_id = $2::uuid RETURNING id", [a.id, id, a.status]);
        if (!u.rows.length) return no(404, "Feature not found.");
        break;
      }
      case "pr_link": {
        const merged = a.status === "merged";
        const u = await tx.query(
          `INSERT INTO staff_project_prs (project_id, pr_number, pr_title, status, merged_at, linked_by) VALUES ($1,$2,$3,$4,$5::timestamptz,$6)
           ON CONFLICT (pr_number) DO NOTHING RETURNING pr_number`, [id, a.prNumber, a.title, a.status, merged ? now.toISOString() : null, staffId]);
        if (!u.rows.length) return no(409, "That PR is already linked to a project.");
        break;
      }
      case "pr_status": {
        const u = await tx.query("UPDATE staff_project_prs SET status = $3, merged_at = CASE WHEN $3 = 'merged' THEN COALESCE(merged_at, $4::timestamptz) ELSE NULL END, updated_at = now() WHERE project_id = $1::uuid AND pr_number = $2 RETURNING pr_number", [id, a.prNumber, a.status, now.toISOString()]);
        if (!u.rows.length) return no(404, "PR is not linked to this project.");
        break;
      }
      case "block":
        if (!live) return no(409, "Only an active project can be blocked.");
        await tx.query("UPDATE staff_project SET blocked_reason = $2, blocked_since = COALESCE(blocked_since, $3::timestamptz) WHERE id = $1::uuid", [id, a.reason, now.toISOString()]);
        break;
      case "unblock":
        await tx.query("UPDATE staff_project SET blocked_reason = NULL, blocked_since = NULL WHERE id = $1::uuid", [id]);
        break;
      case "note": break;
      case "set_status":
        if (a.status === "completed") await tx.query("UPDATE staff_project SET status = 'completed', completed_at = $2::timestamptz, blocked_reason = NULL, blocked_since = NULL WHERE id = $1::uuid", [id, now.toISOString()]);
        else await tx.query("UPDATE staff_project SET status = $2 WHERE id = $1::uuid", [id, a.status]);
        break;
    }
    await touch();
    return { ok: true as const, value: { ok: true as const } };
  });
}

