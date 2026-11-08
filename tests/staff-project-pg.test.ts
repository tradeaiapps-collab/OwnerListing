import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, createProject, decide, getSettings, listPeople, listProjects, projectDetail, setHighBudget } from "../src/server/staff-project-db";
import { parseProposal } from "../src/domain/staff-project";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("internal projects on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });

  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
  async function staff(role = "technical"): Promise<string> {
    const id = await addUser(t.db, "admin");
    await t.db.query("INSERT INTO staff_invite (email, role, accepted_at) SELECT lower(email), $2, now() FROM app_user WHERE id = $1", [id, role]);
    return id;
  }
  const proposal = (ownerId: string, o: Record<string, unknown> = {}) => must(parseProposal({
    title: "Reduce fallthrough", description: "Cut sales that fall through.", goal: "Fewer fallen sales", ownerId, memberIds: [], startDate: "2026-11-01", endDate: "2026-12-30", budgetDollars: 1000,
    storyPoints: 5, estimatedHours: 40, estimatedDays: 10, teamSize: 2, checklist: { scope_clear: true, dependencies_identified: true, resources_available: true, budget_justified: true, effort_estimated: true }, ...o }));
  const who = (id: string, techLead: boolean, review: boolean) => ({ id, canTechLead: techLead, canReview: review });
  const now = new Date("2026-11-10T00:00:00Z");

  it("lists only accepted, unrevoked staff", async () => {
    const a = await staff(); const stranger = await addUser(t.db, "owner");
    const ids = (await listPeople(t.db)).map(p => p.id);
    expect(ids).toContain(a); expect(ids).not.toContain(stranger);
  });

  it("stores a proposal with its risk flags and members, and refuses non-staff", async () => {
    const owner = await staff(), member = await staff(), maker = await staff();
    const r = must(await createProject(t.db, maker, proposal(owner, { memberIds: [member], usesNewTech: true, budgetDollars: 60000 })));
    expect(r.risks.map(x => x.type).sort()).toEqual(["high_budget", "new_tech"]);
    const d = must(await projectDetail(t.db, r.id, now));
    expect(d).toMatchObject({ status: "pending_approval", ownerId: owner, createdBy: maker, memberNames: [expect.any(String)], needs: { techLead: true, stakeholder: true } });
    expect(d.risks).toHaveLength(2);
    const nobody = await addUser(t.db, "owner");
    expect((await createProject(t.db, maker, proposal(nobody))).ok).toBe(false);
  });

  it("goes active only with a tech lead and a stakeholder who are not the proposer or owner; rejection closes it", async () => {
    const owner = await staff(), maker = await staff(), tl = await staff(), fin = await staff("accountant");
    const id = must(await createProject(t.db, maker, proposal(owner))).id;
    const ask = { as: "stakeholder", decision: "approved", comments: "Budget is fine with me." } as const;
    expect((await decide(t.db, who(owner, false, true), id, ask)).ok).toBe(false);
    expect((await decide(t.db, who(maker, true, true), id, { ...ask, as: "tech_lead" })).ok).toBe(false);
    expect(must(await decide(t.db, who(fin, false, true), id, ask)).status).toBe("pending_approval");
    expect((await decide(t.db, who(fin, false, true), id, ask)).ok).toBe(false);
    expect(must(await decide(t.db, who(tl, true, false), id, { as: "tech_lead", decision: "approved", comments: "Technically sound." })).status).toBe("active");
    const d = must(await projectDetail(t.db, id, now));
    expect(d).toMatchObject({ status: "active", approvedByName: expect.any(String) });
    expect(d.approvals.map(a => a.role)).toEqual(["stakeholder", "tech_lead"]);
    expect((await decide(t.db, who(tl, true, false), id, ask)).ok).toBe(false);

    const id2 = must(await createProject(t.db, maker, proposal(owner))).id;
    expect(must(await decide(t.db, who(tl, true, false), id2, { as: "tech_lead", decision: "rejected", comments: "Too big for this quarter." })).status).toBe("rejected");
    expect((await act(t.db, maker, id2, { action: "note", note: "still going" })).ok).toBe(false);
    const n = await t.db.query("SELECT count(*) AS n FROM notification WHERE user_id = $1 AND title LIKE 'Project%'", [owner]);
    expect(Number(n.rows[0]!["n"])).toBe(2);
  });

  async function activeProject() {
    const owner = await staff(), maker = await staff(), tl = await staff(), fin = await staff("accountant");
    const id = must(await createProject(t.db, maker, proposal(owner))).id;
    await decide(t.db, who(fin, false, true), id, { as: "stakeholder", decision: "approved", comments: "Fine by finance." }, now);
    await decide(t.db, who(tl, true, false), id, { as: "tech_lead", decision: "approved", comments: "Fine by tech." }, now);
    return { id, maker, owner };
  }

  it("tracks milestones, features and one PR per project, and moves progress", async () => {
    const { id, maker } = await activeProject(), other = await activeProject();
    const later = new Date("2026-11-20T00:00:00Z");
    must(await act(t.db, maker, id, { action: "milestone_add", value: { phase: "build", description: "Build the thing", targetDate: "2026-11-25" } }, later));
    must(await act(t.db, maker, id, { action: "feature_add", name: "Phase 4", status: "in_progress" }, later));
    expect((await act(t.db, maker, id, { action: "feature_add", name: "Phase 4", status: "planning" }, later)).ok).toBe(false);
    must(await act(t.db, maker, id, { action: "pr_link", prNumber: 231, title: "Pre-qualification", status: "merged" }, later));
    expect((await act(t.db, maker, other.id, { action: "pr_link", prNumber: 231, title: "Dup", status: "open" }, later)).ok).toBe(false);
    must(await act(t.db, maker, id, { action: "pr_link", prNumber: 232, title: "Insights", status: "open" }, later));
    must(await act(t.db, maker, id, { action: "pr_status", prNumber: 232, status: "merged" }, later));
    const d = must(await projectDetail(t.db, id, later));
    expect(d.prs).toEqual({ merged: 2, open: 0, total: 2 });
    expect(d.featureLine).toBe("1 feature: 1 in progress");
    must(await act(t.db, maker, id, { action: "milestone_done", id: d.milestones[0]!.id, actualDate: "2026-11-20" }, later));
    expect(must(await projectDetail(t.db, id, later)).health).toMatchObject({ progress: 100, escalate: false });
    expect((await act(t.db, maker, id, { action: "milestone_done", id: "00000000-0000-4000-8000-0000000000aa", actualDate: "2026-11-20" })).ok).toBe(false);
  });

  it("marks blocked, escalates once after 5 quiet days, and clears the escalation on progress", async () => {
    const { id, maker } = await activeProject();
    const cto = await staff("super_admin");
    expect((await listProjects(t.db, {}, new Date("2026-11-14T00:00:00Z"))).escalatedNow).not.toContain(id);
    const day7 = new Date("2026-11-17T00:00:00Z");
    const a = await listProjects(t.db, {}, day7);
    expect(a.escalatedNow).toContain(id);
    expect((await listProjects(t.db, {}, day7)).escalatedNow).not.toContain(id);
    const n = await t.db.query("SELECT count(*) AS n FROM notification WHERE user_id = $1 AND title = 'Project stuck'", [cto]);
    expect(Number(n.rows[0]!["n"])).toBeGreaterThanOrEqual(1);
    must(await act(t.db, maker, id, { action: "block", reason: "Waiting on the bank API" }, day7));
    const card = (await listProjects(t.db, { status: "active" }, day7)).projects.find(p => p.id === id)!;
    expect(card).toMatchObject({ blockedReason: "Waiting on the bank API", escalatedAt: null });
    expect(card.health.health).toBe("blocked");
    must(await act(t.db, maker, id, { action: "unblock" }, day7));
    must(await act(t.db, maker, id, { action: "set_status", status: "completed" }, day7));
    expect((await act(t.db, maker, id, { action: "feature_add", name: "Late", status: "planning" })).ok).toBe(false);
  });

  it("filters by owner and goal, keeps the admin threshold, and never deletes", async () => {
    const owner = await staff(), maker = await staff();
    const id = must(await createProject(t.db, maker, proposal(owner, { goal: "Unique goal zebra" }))).id;
    expect((await listProjects(t.db, { ownerId: owner })).projects.map(p => p.id)).toEqual([id]);
    expect((await listProjects(t.db, { goal: "zebra" })).projects.map(p => p.id)).toEqual([id]);
    expect((await listProjects(t.db, { goal: "100%_" })).projects).toEqual([]);
    await setHighBudget(t.db, maker, 100_000);
    expect(await getSettings(t.db)).toEqual({ highBudgetCents: 100_000 });
    expect(must(await createProject(t.db, maker, proposal(owner, { budgetDollars: 2000 }))).risks.map(r => r.type)).toContain("high_budget");
    await expect(t.db.query("DELETE FROM staff_project WHERE id = $1", [id])).rejects.toThrow(/permanent record/);
  });
});
