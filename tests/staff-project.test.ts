import { describe, expect, it } from "vitest";
import { approvalOutcome, computeRisks, feasibility, featureSummary, mayDecide, parseAction, parseProposal, progressPct, projectHealth, type MilestoneRow } from "../src/domain/staff-project";

const U = "00000000-0000-4000-8000-000000000001";
const good = { title: "Reduce fallthrough", description: "Cut sales that fall through.", goal: "Fewer fallen sales", ownerId: U, memberIds: [U], startDate: "2026-11-10", endDate: "2026-12-30", budgetDollars: 20000,
  storyPoints: 8, estimatedHours: 80, estimatedDays: 20, teamSize: 2, checklist: { scope_clear: true, dependencies_identified: true, resources_available: true, budget_justified: true, effort_estimated: true } };

describe("parseProposal", () => {
  it("accepts a good proposal and stores cents", () => {
    const r = parseProposal(good);
    expect(r.ok && r.value.budgetCents).toBe(2_000_000);
    expect(r.ok && r.value.memberIds).toEqual([U]);
  });
  it.each([
    [{ title: "ab" }, "title"], [{ endDate: "2026-11-10" }, "end date"], [{ storyPoints: 4 }, "Story points"], [{ startDate: "2026-02-30" }, "dates"],
    [{ budgetDollars: -1 }, "Budget"], [{ checklist: { scope_clear: true } }, "checklist"], [{ ownerId: "nope" }, "owner"], [{ teamSize: 0 }, "Team size"]
  ])("refuses %j", (change, word) => {
    const r = parseProposal({ ...good, ...change });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.toLowerCase()).toContain(String(word).toLowerCase());
  });
  it("refuses a non-object", () => expect(parseProposal(null).ok).toBe(false));
});

describe("computeRisks", () => {
  const base = { startDate: "2026-11-10", endDate: "2026-12-30", budgetCents: 100, estimatedHours: 50, systemsAffected: 1, usesNewTech: false, storyPoints: 5 };
  const types = (o: Partial<typeof base>, t = 5_000_000) => computeRisks({ ...base, ...o }, t).map(r => r.type);
  it("flags nothing for an ordinary project", () => expect(types({})).toEqual([]));
  it("flags a timeline under two weeks, high under one week", () => {
    expect(types({ endDate: "2026-11-23" })).toEqual(["tight_timeline"]);
    expect(computeRisks({ ...base, endDate: "2026-11-15" }, 1)[0]).toMatchObject({ type: "tight_timeline", severity: "high" });
    expect(types({ endDate: "2026-11-24" })).toEqual([]);
  });
  it("flags new technology, complexity (hours or several systems) and budget over the admin threshold", () => {
    expect(types({ usesNewTech: true })).toEqual(["new_tech"]);
    expect(types({ estimatedHours: 101 })).toEqual(["high_complexity"]);
    expect(types({ estimatedHours: 100 })).toEqual([]);
    expect(types({ systemsAffected: 2 })).toEqual(["high_complexity"]);
    expect(types({ budgetCents: 5_000_001 })).toEqual(["high_budget"]);
    expect(types({ budgetCents: 5_000_000 })).toEqual([]);
    expect(types({ budgetCents: 600 }, 500)).toEqual(["high_budget"]);
  });
});

describe("feasibility", () => {
  const f = (o = {}) => feasibility({ checklist: good.checklist, storyPoints: 8, estimatedHours: 80, estimatedDays: 20, teamSize: 2, assumptions: "x", unknowns: "", ...o });
  it("passes when everything is confirmed and the numbers fit", () => expect(f().allOk).toBe(true));
  it("lists what is still open", () => {
    const r = f({ checklist: { ...good.checklist, scope_clear: false } });
    expect(r.allOk).toBe(false);
    expect(r.brief).toContain("scope is clear");
  });
  it("does not accept an effort estimate that needs more than 10 hours per person per day", () => {
    const r = f({ estimatedHours: 400, estimatedDays: 5, teamSize: 2 });
    expect(r.lines.find(l => l.key === "effort_estimated")!.ok).toBe(false);
  });
});

describe("approval", () => {
  it("needs a tech lead and a stakeholder; any rejection ends it", () => {
    expect(approvalOutcome([]).outcome).toBe("pending");
    expect(approvalOutcome([{ approverId: "a", role: "tech_lead", decision: "approved" }])).toMatchObject({ outcome: "pending", needsStakeholder: true, needsTechLead: false });
    expect(approvalOutcome([{ approverId: "a", role: "tech_lead", decision: "approved" }, { approverId: "b", role: "stakeholder", decision: "approved" }]).outcome).toBe("approved");
    expect(approvalOutcome([{ approverId: "a", role: "tech_lead", decision: "approved" }, { approverId: "b", role: "stakeholder", decision: "rejected" }]).outcome).toBe("rejected");
  });
  it("never lets the proposer, the owner or a repeat decider approve, or the wrong permission", () => {
    const p = { status: "pending_approval", createdBy: "maker", ownerId: "owner" };
    const d = { as: "stakeholder", decision: "approved", comments: "Looks fine to me." } as const;
    const can = { canTechLead: false, canReview: true };
    expect(mayDecide({ actorId: "x", ...can }, p, [], d)).toEqual({ ok: true });
    expect(mayDecide({ actorId: "maker", ...can }, p, [], d)).toMatchObject({ ok: false, status: 403 });
    expect(mayDecide({ actorId: "owner", ...can }, p, [], d)).toMatchObject({ ok: false, status: 403 });
    expect(mayDecide({ actorId: "x", ...can }, p, [{ approverId: "x", role: "stakeholder", decision: "approved" }], d)).toMatchObject({ ok: false, status: 409 });
    expect(mayDecide({ actorId: "x", ...can }, p, [], { ...d, as: "tech_lead" })).toMatchObject({ ok: false, status: 403 });
    expect(mayDecide({ actorId: "x", ...can }, { ...p, status: "active" }, [], d)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("health", () => {
  const ms = (...a: [string, string | null][]): MilestoneRow[] => a.map(([t, d], i) => ({ id: String(i), phase: "build", description: "m", targetDate: t, actualDate: d }));
  const p = { status: "active", startDate: "2026-11-01", endDate: "2026-12-01", blockedReason: null as string | null, lastProgressAt: "2026-11-14T00:00:00Z" };
  const now = new Date("2026-11-15T12:00:00Z");
  it("on track with recent progress", () => expect(projectHealth(p, ms(["2026-11-10", "2026-11-09"], ["2026-11-20", null]), now)).toMatchObject({ health: "on_track", escalate: false, progress: 50 }));
  it("blocked wins over at risk", () => expect(projectHealth({ ...p, blockedReason: "waiting on bank" }, ms(["2026-11-01", null]), now).health).toBe("blocked"));
  it("at risk for an overdue milestone", () => { const r = projectHealth(p, ms(["2026-11-10", null]), now); expect(r.health).toBe("at_risk"); expect(r.reasons).toContain("1 milestone overdue"); });
  it("escalates after more than 5 days without progress, not at exactly 5", () => {
    expect(projectHealth({ ...p, lastProgressAt: "2026-11-10T12:00:00Z" }, [], now).escalate).toBe(false);
    const r = projectHealth({ ...p, lastProgressAt: "2026-11-09T11:00:00Z" }, [], now);
    expect(r).toMatchObject({ escalate: true, health: "at_risk", stuckDays: 6 });
  });
  it("only active projects are judged", () => expect(projectHealth({ ...p, status: "on_hold", lastProgressAt: "2026-01-01T00:00:00Z" }, ms(["2026-01-01", null]), now)).toMatchObject({ health: "on_track", escalate: false }));
  it("progress is the share of milestones done", () => { expect(progressPct([])).toBe(0); expect(progressPct(ms(["a", "d"], ["b", null], ["c", null]))).toBe(33); });
});

describe("actions and summaries", () => {
  it("parses actions and refuses bad input", () => {
    expect(parseAction({ action: "pr_link", prNumber: 12, title: "T" })).toEqual({ ok: true, value: { action: "pr_link", prNumber: 12, title: "T", status: "open" } });
    expect(parseAction({ action: "pr_link", prNumber: 0, title: "T" }).ok).toBe(false);
    expect(parseAction({ action: "decide", as: "tech_lead", decision: "approved", comments: "short" }).ok).toBe(false);
    expect(parseAction({ action: "set_status", status: "rejected" }).ok).toBe(false);
    expect(parseAction({ action: "nope" }).ok).toBe(false);
    expect(parseAction({ action: "milestone_done", id: "x", actualDate: "2026-11-01" }).ok).toBe(false);
  });
  it("summarises features", () => {
    expect(featureSummary([])).toBe("No features linked yet");
    expect(featureSummary([{ status: "merged" }, { status: "merged" }, { status: "in_progress" }, { status: "pending_approval" }])).toBe("4 features: 2 merged, 1 in progress, 1 pending approval");
  });
});
