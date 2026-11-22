// Internal project management: proposal checks, feasibility, risk flags, approval rules and health. Pure functions; no database.

export const PROJECT_STATUSES = ["pending_approval", "rejected", "active", "on_hold", "completed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PHASES = ["planning", "design", "build", "test", "ship"] as const;
export type Phase = (typeof PHASES)[number];
export const STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;
export const FEATURE_STATUSES = ["planning", "in_progress", "merged", "pending_approval"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];
export const PR_STATUSES = ["draft", "open", "needs_review", "merged", "closed"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];
export type Severity = "low" | "medium" | "high";
export type RiskType = "tight_timeline" | "new_tech" | "high_complexity" | "high_budget";

/** A project with no progress for more than this many days goes to the CTO. */
export const STUCK_DAYS = 5;
export const TIGHT_DAYS = 14;
export const COMPLEX_HOURS = 100;
export const DEFAULT_HIGH_BUDGET_CENTS = 5_000_000;
const DAY = 86_400_000;

export const CHECKLIST_ITEMS = [
  { key: "scope_clear", label: "Scope is clear" },
  { key: "dependencies_identified", label: "Dependencies are identified" },
  { key: "resources_available", label: "People are available" },
  { key: "budget_justified", label: "Budget is justified" },
  { key: "effort_estimated", label: "Effort is estimated" }
] as const;
export type ChecklistKey = (typeof CHECKLIST_ITEMS)[number]["key"];
export type Checklist = Record<ChecklistKey, boolean>;

export interface ProposalInput {
  title: string; description: string; goal: string; ownerId: string; memberIds: string[];
  startDate: string; endDate: string; budgetCents: number;
  storyPoints: number; estimatedHours: number; estimatedDays: number; teamSize: number;
  usesNewTech: boolean; systemsAffected: number; assumptions: string; unknowns: string; checklist: Checklist;
}
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const text = (v: unknown, min: number, max: number) => (typeof v === "string" && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
const optText = (v: unknown, max: number) => (v === undefined || v === null || v === "" ? "" : typeof v === "string" && v.trim().length <= max ? v.trim() : null);
const int = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Checks a proposal form. The budget arrives in dollars and is stored in cents. */
export function parseProposal(b: Record<string, unknown> | null): Parsed<ProposalInput> {
  if (!b) return bad("Send the proposal as JSON.");
  const title = text(b["title"], 3, 120); if (!title) return bad("Give the project a title of 3 to 120 characters.");
  const description = text(b["description"], 10, 4000); if (!description) return bad("Describe the project in 10 to 4000 characters.");
  const goal = text(b["goal"], 3, 500); if (!goal) return bad("Name the strategic goal in 3 to 500 characters.");
  if (typeof b["ownerId"] !== "string" || !UUID_RE.test(b["ownerId"])) return bad("Choose the project owner.");
  const members = b["memberIds"] === undefined ? [] : b["memberIds"];
  if (!Array.isArray(members) || members.length > 50 || !members.every(m => typeof m === "string" && UUID_RE.test(m))) return bad("Team members must be a list of staff.");
  if (!isDay(b["startDate"]) || !isDay(b["endDate"])) return bad("Start and end dates must be real dates (YYYY-MM-DD).");
  if (daysBetween(b["startDate"], b["endDate"]) < 1) return bad("The end date must be after the start date.");
  const dollars = b["budgetDollars"];
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0 || dollars > 100_000_000) return bad("Budget must be a dollar amount of 0 or more.");
  const storyPoints = b["storyPoints"];
  if (typeof storyPoints !== "number" || !(STORY_POINTS as readonly number[]).includes(storyPoints)) return bad("Story points must be 1, 2, 3, 5, 8, 13 or 21.");
  const estimatedHours = int(b["estimatedHours"], 1, 100000); if (estimatedHours === null) return bad("Estimated hours must be a whole number of 1 or more.");
  const estimatedDays = int(b["estimatedDays"], 1, 3650); if (estimatedDays === null) return bad("Estimated days must be a whole number of 1 or more.");
  const teamSize = int(b["teamSize"], 1, 200); if (teamSize === null) return bad("Team size must be a whole number of 1 or more.");
  const systemsAffected = b["systemsAffected"] === undefined ? 1 : int(b["systemsAffected"], 1, 50); if (systemsAffected === null) return bad("Systems affected must be a whole number from 1 to 50.");
  const assumptions = optText(b["assumptions"], 2000), unknowns = optText(b["unknowns"], 2000);
  if (assumptions === null || unknowns === null) return bad("Assumptions and unknowns are limited to 2000 characters each.");
  const c = b["checklist"];
  if (!c || typeof c !== "object" || Array.isArray(c)) return bad("Answer the feasibility checklist.");
  const checklist = {} as Checklist;
  for (const { key } of CHECKLIST_ITEMS) { const v = (c as Record<string, unknown>)[key]; if (typeof v !== "boolean") return bad("Answer every item on the feasibility checklist."); checklist[key] = v; }
  return { ok: true, value: {
    title, description, goal, ownerId: b["ownerId"], memberIds: [...new Set(members as string[])], startDate: b["startDate"], endDate: b["endDate"],
    budgetCents: Math.round(dollars * 100), storyPoints, estimatedHours, estimatedDays, teamSize, usesNewTech: b["usesNewTech"] === true, systemsAffected, assumptions, unknowns, checklist
  } };
}

export interface RiskFlag { type: RiskType; severity: Severity; description: string }

/** Flags worked out from the proposal alone, so the same inputs always give the same flags. `highBudgetCents` is the admin's threshold. */
export function computeRisks(p: Pick<ProposalInput, "startDate" | "endDate" | "budgetCents" | "estimatedHours" | "systemsAffected" | "usesNewTech" | "storyPoints">, highBudgetCents: number): RiskFlag[] {
  const out: RiskFlag[] = [];
  const days = daysBetween(p.startDate, p.endDate);
  if (days < TIGHT_DAYS) out.push({ type: "tight_timeline", severity: days < 7 ? "high" : "medium", description: `Only ${days} day${days === 1 ? "" : "s"} from start to end (under ${TIGHT_DAYS}).` });
  if (p.usesNewTech) out.push({ type: "new_tech", severity: "medium", description: "Uses a technology, framework or external API the team has not shipped with before." });
  if (p.estimatedHours > COMPLEX_HOURS || p.systemsAffected > 1) {
    const why = [p.estimatedHours > COMPLEX_HOURS ? `${p.estimatedHours} hours estimated (over ${COMPLEX_HOURS})` : "", p.systemsAffected > 1 ? `touches ${p.systemsAffected} systems` : ""].filter(Boolean).join("; ");
    out.push({ type: "high_complexity", severity: p.estimatedHours > COMPLEX_HOURS * 3 || p.systemsAffected > 3 || p.storyPoints >= 21 ? "high" : "medium", description: `${why[0]!.toUpperCase()}${why.slice(1)}.` });
  }
  if (p.budgetCents > highBudgetCents) out.push({ type: "high_budget", severity: p.budgetCents > highBudgetCents * 2 ? "high" : "medium", description: `Budget is above the ${aud(highBudgetCents)} threshold.` });
  return out;
}

export const aud = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { maximumFractionDigits: 0 })}`;

export interface FeasibilityLine { key: ChecklistKey; label: string; ok: boolean; note: string }
/** The checklist as answered, with "effort estimated" also checked against the numbers (a points/hours pair that makes no sense is not ok). */
export function feasibility(p: Pick<ProposalInput, "checklist" | "storyPoints" | "estimatedHours" | "estimatedDays" | "teamSize" | "assumptions" | "unknowns">): { lines: FeasibilityLine[]; allOk: boolean; brief: string } {
  const perDay = p.estimatedHours / Math.max(1, p.estimatedDays * p.teamSize);
  const lines: FeasibilityLine[] = CHECKLIST_ITEMS.map(({ key, label }) => {
    let ok = p.checklist[key], note = ok ? "Confirmed by the proposer." : "Not confirmed.";
    if (key === "effort_estimated" && ok && perDay > 10) { ok = false; note = `${p.estimatedHours} hours in ${p.estimatedDays} days with ${p.teamSize} people is over 10 hours per person per day.`; }
    return { key, label, ok, note };
  });
  const allOk = lines.every(l => l.ok);
  const open = lines.filter(l => !l.ok).map(l => l.label.toLowerCase());
  const brief = `Effort: ${p.storyPoints} points, about ${p.estimatedHours} hours over ${p.estimatedDays} days with ${p.teamSize} ${p.teamSize === 1 ? "person" : "people"}. ` +
    (allOk ? "Every checklist item is confirmed." : `Still open: ${open.join(", ")}.`) +
    (p.unknowns ? " Unknowns are listed, so ask about them before approving." : p.assumptions ? "" : " No assumptions or unknowns were written down, which is unusual for work of this size.");
  return { lines, allOk, brief };
}

// ---- Approval ----

export interface ApprovalRow { approverId: string; role: "tech_lead" | "stakeholder"; decision: "approved" | "rejected" }
export type Outcome = "pending" | "approved" | "rejected";

/**
 * A project goes live when a tech lead has signed off AND at least one stakeholder has approved, all different people.
 * Any rejection ends the proposal (a new proposal can be made). The proposer and owner never count as approvers.
 */
export function approvalOutcome(rows: readonly ApprovalRow[]): { outcome: Outcome; needsTechLead: boolean; needsStakeholder: boolean } {
  if (rows.some(r => r.decision === "rejected")) return { outcome: "rejected", needsTechLead: false, needsStakeholder: false };
  const techLead = rows.some(r => r.role === "tech_lead"), stakeholder = rows.some(r => r.role === "stakeholder");
  return { outcome: techLead && stakeholder ? "approved" : "pending", needsTechLead: !techLead, needsStakeholder: !stakeholder };
}

export interface DecideInput { as: "tech_lead" | "stakeholder"; decision: "approved" | "rejected"; comments: string }
export function parseDecision(b: Record<string, unknown> | null): Parsed<DecideInput> {
  if (!b) return bad("Send the decision as JSON.");
  if (b["as"] !== "tech_lead" && b["as"] !== "stakeholder") return bad("Say whether you decide as tech lead or stakeholder.");
  if (b["decision"] !== "approved" && b["decision"] !== "rejected") return bad("The decision must be approved or rejected.");
  const comments = text(b["comments"], 10, 1000); if (!comments) return bad("Add a comment of at least 10 characters.");
  return { ok: true, value: { as: b["as"], decision: b["decision"], comments } };
}

export interface Denied { ok: false; status: number; error: string }
export function mayDecide(a: { actorId: string; canTechLead: boolean; canReview: boolean }, p: { status: string; createdBy: string; ownerId: string }, existing: readonly ApprovalRow[], d: DecideInput): { ok: true } | Denied {
  const no = (status: number, error: string): Denied => ({ ok: false, status, error });
  if (p.status !== "pending_approval") return no(409, "This project is not waiting for approval.");
  if (d.as === "tech_lead" ? !a.canTechLead : !a.canReview) return no(403, d.as === "tech_lead" ? "Only a tech lead can sign off." : "You cannot approve as a stakeholder.");
  if (a.actorId === p.createdBy || a.actorId === p.ownerId) return no(403, "The person who proposed or owns a project cannot approve it.");
  if (existing.some(r => r.approverId === a.actorId)) return no(409, "You have already decided on this project.");
  return { ok: true };
}

// ---- Tracking ----

export interface MilestoneRow { id: string; phase: Phase; description: string; targetDate: string; actualDate: string | null }
export interface MilestoneInput { phase: Phase; description: string; targetDate: string }

export function parseMilestone(b: Record<string, unknown> | null): Parsed<MilestoneInput> {
  if (!b) return bad("Send the milestone as JSON.");
  if (typeof b["phase"] !== "string" || !(PHASES as readonly string[]).includes(b["phase"])) return bad("Phase must be planning, design, build, test or ship.");
  const description = text(b["description"], 3, 300); if (!description) return bad("Describe the milestone in 3 to 300 characters.");
  if (!isDay(b["targetDate"])) return bad("The target date must be a real date (YYYY-MM-DD).");
  return { ok: true, value: { phase: b["phase"] as Phase, description, targetDate: b["targetDate"] } };
}

/** Share of milestones done, as a whole percent. No milestones means no measure yet (0). */
export const progressPct = (m: readonly Pick<MilestoneRow, "actualDate">[]): number => (m.length === 0 ? 0 : Math.round((m.filter(x => x.actualDate !== null).length / m.length) * 100));

export type Health = "on_track" | "at_risk" | "blocked";
export interface HealthInfo {
  health: Health; reasons: string[]; progress: number; daysRemaining: number; plannedDays: number; elapsedPct: number;
  nextMilestone: MilestoneRow | null; stuckDays: number; escalate: boolean;
}

/**
 * Blocked: someone recorded a blocker. At risk: a milestone is overdue, the end date has passed, no progress for more than 5 days,
 * or the calendar is more than 25 points ahead of the milestones. Otherwise on track. `escalate` means send to the CTO (no progress > 5 days).
 */
export function projectHealth(p: { status: string; startDate: string; endDate: string; blockedReason: string | null; lastProgressAt: string }, milestones: readonly MilestoneRow[], now: Date): HealthInfo {
  const today = now.toISOString().slice(0, 10);
  const plannedDays = daysBetween(p.startDate, p.endDate), daysRemaining = daysBetween(today, p.endDate);
  const elapsedPct = Math.max(0, Math.min(100, Math.round((daysBetween(p.startDate, today) / plannedDays) * 100)));
  const progress = progressPct(milestones);
  const open = milestones.filter(m => m.actualDate === null).sort((a, b) => a.targetDate.localeCompare(b.targetDate));
  const stuckDays = Math.floor((now.getTime() - Date.parse(p.lastProgressAt)) / DAY);
  const live = p.status === "active";
  const reasons: string[] = [];
  if (live) {
    if (p.blockedReason) reasons.push(`Blocked: ${p.blockedReason}`);
    const overdue = open.filter(m => m.targetDate < today);
    if (overdue.length) reasons.push(`${overdue.length} milestone${overdue.length === 1 ? "" : "s"} overdue`);
    if (daysRemaining < 0) reasons.push(`${-daysRemaining} day${daysRemaining === -1 ? "" : "s"} past the end date`);
    if (stuckDays > STUCK_DAYS) reasons.push(`No progress for ${stuckDays} days`);
    if (milestones.length > 0 && elapsedPct - progress > 25 && daysRemaining >= 0) reasons.push(`Calendar is ${elapsedPct}% through but milestones are ${progress}% done`);
  }
  return {
    health: !live ? "on_track" : p.blockedReason ? "blocked" : reasons.length ? "at_risk" : "on_track", reasons, progress, daysRemaining, plannedDays, elapsedPct,
    nextMilestone: open[0] ?? null, stuckDays, escalate: live && stuckDays > STUCK_DAYS
  };
}

export const HEALTH_LABEL: Record<Health, string> = { on_track: "On track", at_risk: "At risk", blocked: "Blocked" };
export const STATUS_LABEL: Record<ProjectStatus, string> = { pending_approval: "Waiting for approval", rejected: "Rejected", active: "Active", on_hold: "On hold", completed: "Completed" };

// ---- Actions on an existing project ----

export type ProjectAction =
  | { action: "decide"; value: DecideInput }
  | { action: "milestone_add"; value: MilestoneInput }
  | { action: "milestone_done"; id: string; actualDate: string }
  | { action: "feature_add"; name: string; status: FeatureStatus }
  | { action: "feature_status"; id: string; status: FeatureStatus }
  | { action: "pr_link"; prNumber: number; title: string; status: PrStatus }
  | { action: "pr_status"; prNumber: number; status: PrStatus }
  | { action: "block"; reason: string }
  | { action: "unblock" }
  | { action: "note"; note: string }
  | { action: "set_status"; status: "active" | "on_hold" | "completed" };

export function parseAction(b: Record<string, unknown> | null): Parsed<ProjectAction> {
  if (!b) return bad("Send the action as JSON.");
  const fs = (v: unknown): v is FeatureStatus => typeof v === "string" && (FEATURE_STATUSES as readonly string[]).includes(v);
  const ps = (v: unknown): v is PrStatus => typeof v === "string" && (PR_STATUSES as readonly string[]).includes(v);
  switch (b["action"]) {
    case "decide": { const d = parseDecision(b); return d.ok ? { ok: true, value: { action: "decide", value: d.value } } : d; }
    case "milestone_add": { const m = parseMilestone(b); return m.ok ? { ok: true, value: { action: "milestone_add", value: m.value } } : m; }
    case "milestone_done":
      if (typeof b["id"] !== "string" || !UUID_RE.test(b["id"])) return bad("Unknown milestone.");
      if (!isDay(b["actualDate"])) return bad("Give the completion date (YYYY-MM-DD).");
      return { ok: true, value: { action: "milestone_done", id: b["id"], actualDate: b["actualDate"] } };
    case "feature_add": {
      const name = text(b["name"], 2, 160); if (!name) return bad("Name the feature in 2 to 160 characters.");
      const status = b["status"] === undefined ? "planning" : b["status"]; if (!fs(status)) return bad("Unknown feature status.");
      return { ok: true, value: { action: "feature_add", name, status } };
    }
    case "feature_status":
      if (typeof b["id"] !== "string" || !UUID_RE.test(b["id"])) return bad("Unknown feature.");
      if (!fs(b["status"])) return bad("Unknown feature status.");
      return { ok: true, value: { action: "feature_status", id: b["id"], status: b["status"] } };
    case "pr_link": {
      const n = int(b["prNumber"], 1, 10_000_000); if (n === null) return bad("Give the PR number.");
      const title = text(b["title"], 1, 200); if (!title) return bad("Give the PR title.");
      const status = b["status"] === undefined ? "open" : b["status"]; if (!ps(status)) return bad("Unknown PR status.");
      return { ok: true, value: { action: "pr_link", prNumber: n, title, status } };
    }
    case "pr_status": {
      const n = int(b["prNumber"], 1, 10_000_000); if (n === null) return bad("Give the PR number.");
      if (!ps(b["status"])) return bad("Unknown PR status.");
      return { ok: true, value: { action: "pr_status", prNumber: n, status: b["status"] } };
    }
    case "block": { const reason = text(b["reason"], 3, 500); return reason ? { ok: true, value: { action: "block", reason } } : bad("Say what is blocking the project (3 to 500 characters)."); }
    case "unblock": return { ok: true, value: { action: "unblock" } };
    case "note": { const note = text(b["note"], 3, 500); return note ? { ok: true, value: { action: "note", note } } : bad("Write a progress note (3 to 500 characters)."); }
    case "set_status": return b["status"] === "active" || b["status"] === "on_hold" || b["status"] === "completed" ? { ok: true, value: { action: "set_status", status: b["status"] } } : bad("Status must be active, on_hold or completed.");
    default: return bad("Unknown action.");
  }
}

/** Features by status, for the line "5 features merged, 2 in progress, 1 pending approval". */
export function featureSummary(features: readonly { status: FeatureStatus }[]): string {
  const n = (s: FeatureStatus) => features.filter(f => f.status === s).length;
  const parts = [`${n("merged")} merged`, `${n("in_progress")} in progress`, `${n("pending_approval")} pending approval`, `${n("planning")} planned`].filter(x => !x.startsWith("0 "));
  return features.length === 0 ? "No features linked yet" : `${features.length} feature${features.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}
