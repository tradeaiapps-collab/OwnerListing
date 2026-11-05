import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember, advanceCommission, changeMember, createTask, createTeam, listCommissions, listTasks, myTeams,
  recordCommission, removeMember, teamDashboard, teamDetail, updateTask, updateTeam
} from "../src/domain/agency-team";
import type { Actor } from "../src/domain/listing-service";
import { createPgAgencyTeamRepository } from "../src/server/agency-team-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

describe.skipIf(!DATABASE_URL)("agency teams on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  let clock = Date.parse("2026-11-05T00:00:00Z");
  const ids = { newId: () => randomUUID(), now: () => new Date(clock).toISOString() };

  async function person(type: "agent" | "owner" | "buyer" | "admin" = "agent", status = "active") {
    const id = await addUser(t.db, type, status);
    const email = String((await t.db.query("SELECT email FROM app_user WHERE id = $1", [id])).rows[0]!["email"]);
    return { actor: { userId: id, userType: type } as Actor, email };
  }
  async function team() {
    const repo = createPgAgencyTeamRepository(t.db);
    const boss = await person();
    const c = await createTeam(repo, boss.actor, { name: "North office", kind: "office" }, ids);
    if (!c.ok) throw new Error("create");
    return { repo, boss, teamId: c.value.id };
  }
  const join = async (repo: ReturnType<typeof createPgAgencyTeamRepository>, boss: Actor, teamId: string, role: string, type: "agent" | "owner" = "agent") => {
    const p = await person(type);
    const r = await addMember(repo, boss, teamId, { email: p.email, role }, ids);
    if (!r.ok) throw new Error(`join ${role}: ${r.message}`);
    return p.actor;
  };

  it("only agents create teams; the creator is the manager; outsiders get 404", async () => {
    const repo = createPgAgencyTeamRepository(t.db);
    const owner = await person("owner");
    expect(await createTeam(repo, owner.actor, { name: "Nope" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    const boss = await person();
    expect(await createTeam(repo, boss.actor, { name: "x" }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await createTeam(repo, boss.actor, { name: "Team A", defaultMemberBps: 10001 }, ids)).toMatchObject({ ok: false, code: "invalid" });
    const c = await createTeam(repo, boss.actor, { name: "Team A" }, ids);
    if (!c.ok) throw new Error("create");
    expect(await myTeams(repo, boss.actor)).toMatchObject({ ok: true, value: [{ id: c.value.id, role: "manager", memberCount: 1, defaultMemberBps: 7000 }] });
    const outsider = await person();
    expect(await teamDetail(repo, outsider.actor, c.value.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await teamDetail(repo, boss.actor, "not-a-uuid")).toMatchObject({ ok: false, code: "not_found" });
    const audits = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_id = $1", [c.value.id]);
    expect(audits.rows.map(r => r["event_type"])).toEqual(["agency_team.created"]);
  });

  it("adds members by email with role rules, hides emails and splits from non-managers, and keeps a manager", async () => {
    const { repo, boss, teamId } = await team();
    const agent = await join(repo, boss.actor, teamId, "agent");
    const staff = await join(repo, boss.actor, teamId, "staff", "owner");
    const owner = await person("owner");
    expect(await addMember(repo, boss.actor, teamId, { email: owner.email, role: "agent" }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await addMember(repo, boss.actor, teamId, { email: (await person("admin")).email, role: "staff" }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await addMember(repo, boss.actor, teamId, { email: "nobody@example.test", role: "staff" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await addMember(repo, boss.actor, teamId, { email: (await person("agent", "suspended")).email, role: "agent" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    const again = await t.db.query("SELECT email FROM app_user WHERE id = $1", [agent.userId]);
    expect(await addMember(repo, boss.actor, teamId, { email: String(again.rows[0]!["email"]), role: "agent" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await addMember(repo, agent, teamId, { email: owner.email, role: "staff" }, ids)).toMatchObject({ ok: false, code: "forbidden" });

    expect(await changeMember(repo, boss.actor, teamId, agent.userId, { memberBps: 5500 }, ids)).toMatchObject({ ok: true });
    expect(await changeMember(repo, boss.actor, teamId, agent.userId, { memberBps: 12000 }, ids)).toMatchObject({ ok: false, code: "invalid" });
    // A staff (owner-type) account cannot be promoted to agent.
    expect(await changeMember(repo, boss.actor, teamId, staff.userId, { role: "agent" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    // The only manager cannot be demoted or leave.
    expect(await changeMember(repo, boss.actor, teamId, boss.actor.userId, { role: "agent" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await removeMember(repo, boss.actor, teamId, boss.actor.userId, ids)).toMatchObject({ ok: false, code: "conflict" });

    const asBoss = await teamDetail(repo, boss.actor, teamId);
    const asAgent = await teamDetail(repo, agent, teamId);
    if (!asBoss.ok || !asAgent.ok) throw new Error("detail");
    expect(asBoss.value.members.find(m => m.userId === agent.userId)).toMatchObject({ memberBps: 5500, email: expect.any(String) });
    expect(asAgent.value.members.every(m => m.email === undefined)).toBe(true);
    expect(asAgent.value.members.find(m => m.userId === agent.userId)?.memberBps).toBe(5500);
    expect(asAgent.value.members.find(m => m.userId === boss.actor.userId)?.memberBps).toBeNull();

    // A second manager lets the first step down; a removed member can be re-added with the split reset.
    const second = await join(repo, boss.actor, teamId, "manager");
    expect(await changeMember(repo, second, teamId, boss.actor.userId, { role: "agent" }, ids)).toMatchObject({ ok: true });
    expect(await removeMember(repo, agent, teamId, agent.userId, ids)).toMatchObject({ ok: true });
    expect(await teamDetail(repo, agent, teamId)).toMatchObject({ ok: false, code: "not_found" });
    const again2 = await addMember(repo, second, teamId, { email: String(again.rows[0]!["email"]), role: "agent" }, ids);
    expect(again2).toMatchObject({ ok: true });
    expect((await repo.getMembership(teamId, agent.userId))?.memberBps).toBeNull();
    expect(await updateTeam(repo, second, teamId, { name: "North HQ", defaultMemberBps: 6000 }, ids)).toMatchObject({ ok: true, value: { name: "North HQ", defaultMemberBps: 6000 } });
    expect(await updateTeam(repo, agent, teamId, { name: "Mine" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("assigns tasks: managers assign anyone, others only themselves; assignees change status only; removal needs no open tasks", async () => {
    const { repo, boss, teamId } = await team();
    const a1 = await join(repo, boss.actor, teamId, "agent");
    const a2 = await join(repo, boss.actor, teamId, "agent");
    const outsider = await person();
    const owner = await person("owner");
    const listing = await addListing(t.db, owner.actor.userId);

    const task = await createTask(repo, boss.actor, teamId, { title: "Call vendor", assigneeUserId: a1.userId, dueDate: "2026-11-01", listingId: listing }, ids);
    if (!task.ok) throw new Error(`task ${task.message}`);
    expect(await createTask(repo, a1, teamId, { title: "For someone else", assigneeUserId: a2.userId }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await createTask(repo, a1, teamId, { title: "Own task" }, ids)).toMatchObject({ ok: true, value: { assigneeUserId: a1.userId } });
    expect(await createTask(repo, boss.actor, teamId, { title: "Bad assignee", assigneeUserId: outsider.actor.userId }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await createTask(repo, boss.actor, teamId, { title: "Bad date", dueDate: "2026-02-31" }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await createTask(repo, boss.actor, teamId, { title: "Bad listing", listingId: randomUUID() }, ids)).toMatchObject({ ok: false, code: "invalid" });

    const mine = await listTasks(repo, a1, teamId);
    const all = await listTasks(repo, boss.actor, teamId);
    expect(mine.ok && mine.value.length).toBe(2);
    expect(all.ok && all.value.length).toBe(2);
    expect(await listTasks(repo, a2, teamId)).toMatchObject({ ok: true, value: [] });

    expect(await updateTask(repo, a2, teamId, task.value.id, { status: "done" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateTask(repo, a1, teamId, task.value.id, { assigneeUserId: a2.userId }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await removeMember(repo, boss.actor, teamId, a1.userId, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await updateTask(repo, a1, teamId, task.value.id, { status: "done" }, ids)).toMatchObject({ ok: true, value: { status: "done", completedAt: ids.now() } });
    expect(await updateTask(repo, a1, teamId, task.value.id, { status: "open" }, ids)).toMatchObject({ ok: true, value: { status: "open", completedAt: null } });
    expect(await updateTask(repo, boss.actor, teamId, task.value.id, { assigneeUserId: a2.userId, dueDate: null }, ids)).toMatchObject({ ok: true, value: { assigneeUserId: a2.userId, dueDate: null } });
  });

  it("records commission with the split in force, never changes it, and moves recorded -> approved -> paid by a manager only", async () => {
    const { repo, boss, teamId } = await team();
    const agent = await join(repo, boss.actor, teamId, "agent");
    const other = await join(repo, boss.actor, teamId, "agent");
    const staff = await join(repo, boss.actor, teamId, "staff", "owner");
    await changeMember(repo, boss.actor, teamId, other.userId, { memberBps: 5000 }, ids);

    expect(await recordCommission(repo, agent, teamId, { memberUserId: agent.userId, grossCents: 100 }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await recordCommission(repo, boss.actor, teamId, { memberUserId: staff.userId, grossCents: 100 }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await recordCommission(repo, boss.actor, teamId, { memberUserId: agent.userId, grossCents: 0 }, ids)).toMatchObject({ ok: false, code: "invalid" });
    expect(await recordCommission(repo, boss.actor, teamId, { memberUserId: agent.userId, grossCents: 10.5 }, ids)).toMatchObject({ ok: false, code: "invalid" });

    const a = await recordCommission(repo, boss.actor, teamId, { memberUserId: agent.userId, grossCents: 1_000_001, description: "12 Smith St" }, ids);
    const b = await recordCommission(repo, boss.actor, teamId, { memberUserId: other.userId, grossCents: 200_000 }, ids);
    if (!a.ok || !b.ok) throw new Error("record");
    expect(a.value).toMatchObject({ memberBps: 7000, memberCents: 700_000, officeCents: 300_001, status: "recorded" });
    expect(b.value).toMatchObject({ memberBps: 5000, memberCents: 100_000, officeCents: 100_000 });

    // Changing the team default or a member's split later does not touch recorded entries.
    await updateTeam(repo, boss.actor, teamId, { defaultMemberBps: 1000 }, ids);
    expect((await repo.getCommission(teamId, a.value.id))?.memberCents).toBe(700_000);

    const seen = (x: Actor) => listCommissions(repo, x, teamId).then(r => (r.ok ? r.value.length : -1));
    expect([await seen(boss.actor), await seen(agent), await seen(other), await seen(staff)]).toEqual([2, 1, 1, 0]);

    expect(await advanceCommission(repo, boss.actor, teamId, a.value.id, { action: "mark_paid" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await advanceCommission(repo, agent, teamId, a.value.id, { action: "approve" }, ids)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await advanceCommission(repo, boss.actor, teamId, a.value.id, { action: "approve" }, ids)).toMatchObject({ ok: true, value: { status: "approved", approvedAt: ids.now() } });
    expect(await advanceCommission(repo, boss.actor, teamId, a.value.id, { action: "approve" }, ids)).toMatchObject({ ok: false, code: "conflict" });
    expect(await advanceCommission(repo, boss.actor, teamId, a.value.id, { action: "mark_paid", payoutReference: "EFT 4471" }, ids)).toMatchObject({ ok: true, value: { status: "paid", payoutReference: "EFT 4471" } });
    expect(await advanceCommission(repo, boss.actor, teamId, randomUUID(), { action: "approve" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    const events = await t.db.query("SELECT event_type FROM audit_event WHERE aggregate_id = $1 ORDER BY occurred_at, event_type", [a.value.id]);
    expect(events.rows.map(r => r["event_type"]).sort()).toEqual(["agency_commission.approved", "agency_commission.paid", "agency_commission.recorded"]);
    // The database refuses to let money columns disagree.
    await expect(t.db.query("UPDATE agency_commission SET office_cents = office_cents + 1 WHERE id = $1", [a.value.id])).rejects.toThrow();
  });

  it("builds the dashboard: managers see money and Elena's read; others only their own money", async () => {
    const { repo, boss, teamId } = await team();
    const agent = await join(repo, boss.actor, teamId, "agent");
    const mate = await join(repo, boss.actor, teamId, "agent");
    const owner = await person("owner");
    for (let i = 0; i < 3; i++) await createTask(repo, boss.actor, teamId, { title: `Late ${i}`, assigneeUserId: agent.userId, dueDate: "2026-10-01" }, ids);
    await createTask(repo, boss.actor, teamId, { title: "Future", assigneeUserId: mate.userId, dueDate: "2026-12-01" }, ids);
    const done = await createTask(repo, mate, teamId, { title: "Done" }, ids);
    if (!done.ok) throw new Error("task");
    await updateTask(repo, mate, teamId, done.value.id, { status: "done" }, ids);
    const listing = await addListing(t.db, owner.actor.userId);
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, agent.userId, owner.actor.userId]);
    const c = await recordCommission(repo, boss.actor, teamId, { memberUserId: agent.userId, grossCents: 1_000_000 }, ids);
    if (!c.ok) throw new Error("commission");
    clock += 20 * 86_400_000;

    const m = await teamDashboard(repo, boss.actor, teamId, ids);
    if (!m.ok) throw new Error("dash");
    const row = m.value.rows.find(r => r.userId === agent.userId);
    expect(row).toMatchObject({ activeListings: 1, openTasks: 3, overdueTasks: 3, owedCents: 700_000, recordedCents: 700_000, paidCents: 0 });
    expect(m.value.rows.find(r => r.userId === mate.userId)).toMatchObject({ openTasks: 1, overdueTasks: 0, doneLast30: 1 });
    expect(m.value.totals).toMatchObject({ members: 3, activeListings: 1, openTasks: 4, overdueTasks: 3, owedCents: 700_000 });
    expect(m.value.insights?.map(i => i.kind)).toEqual(expect.arrayContaining(["overdue_tasks", "stale_payout"]));
    expect(m.value.summary).toContain("I found");

    const a = await teamDashboard(repo, agent, teamId, ids);
    const o = await teamDashboard(repo, mate, teamId, ids);
    if (!a.ok || !o.ok) throw new Error("dash");
    expect(a.value.insights).toBeNull();
    expect(a.value.summary).toBeNull();
    expect(a.value.rows.find(r => r.userId === agent.userId)?.owedCents).toBe(700_000);
    expect(a.value.rows.find(r => r.userId === mate.userId)?.owedCents).toBeNull();
    expect(o.value.rows.find(r => r.userId === agent.userId)?.owedCents).toBeNull();
    expect(o.value.totals.owedCents).toBeNull();
    expect(await teamDashboard(repo, (await person()).actor, teamId, ids)).toMatchObject({ ok: false, code: "not_found" });
  });
});
