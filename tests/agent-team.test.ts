import { describe, expect, it } from "vitest";
import {
  archiveTeam, askTeamAssistant, assignTask, commissionSplit, createTeam, getMyTeams, getTeam, inviteMember, removeMember, respondToInvitation, updateMember, updateTask, updateTeam,
  type MemberFact, type Membership, type TaskFact, type TeamDeps, type TeamFact
} from "../src/domain/agent-team";
import type { LeadFact } from "../src/domain/agent-workspace";
import type { AgentLicence } from "../src/domain/licence";
import type { Actor } from "../src/domain/listing-service";

const now = new Date("2026-11-05T00:00:00Z");
const team: TeamFact = { id: "t1", name: "Harbour Realty", commissionRateBps: 200 };
const act = (id: string): Actor => ({ userId: id, userType: "agent" });
const names: Record<string, string> = { p: "Pat", m: "Mel", a: "Alex", b: "Bo", x: "Xi" };

/** In-memory deps: a team with principal p, manager m, agents a and b; x is a licensed agent outside the team. */
function world(o: { tasks?: TaskFact[]; leads?: Record<string, LeadFact[]>; log?: string[] } = {}) {
  const log = o.log ?? [];
  let members: MemberFact[] = [
    { userId: "p", name: "Pat", role: "principal", status: "active", agentShareBps: 7000 }, { userId: "m", name: "Mel", role: "manager", status: "active", agentShareBps: 6000 },
    { userId: "a", name: "Alex", role: "agent", status: "active", agentShareBps: 5000 }, { userId: "b", name: "Bo", role: "agent", status: "active", agentShareBps: 5000 }
  ];
  let tasks = o.tasks ?? [];
  const licensed = ["p", "m", "a", "b", "x"];
  const d: TeamDeps = {
    licences: async () => licensed.map((u): AgentLicence => ({ userId: u, jurisdiction: "QLD", status: "verified" })), today: () => "2026-11-05", now: () => now,
    memberships: async u => members.filter(m => m.userId === u).map((m): Membership => ({ team, role: m.role, status: m.status })),
    team: async id => (id === "t1" ? team : undefined), members: async () => members,
    findAgentByEmail: async e => (e === "x@example.test" ? { userId: "x", name: "Xi" } : e === "a@example.test" ? { userId: "a", name: "Alex" } : e === "nolicence@example.test" ? { userId: "z", name: "Zed" } : undefined),
    createTeam: async (n, u) => { log.push(`create:${n}:${u}`); return "t2"; },
    upsertInvite: async (...a) => { log.push(`invite:${a.join("|")}`); members = [...members, { userId: a[1], name: names[a[1]] ?? "?", role: a[2], status: "invited", agentShareBps: 5000 }]; },
    activate: async (t, u) => { log.push(`activate:${t}:${u}`); return true; },
    endMembership: async (t, u) => { log.push(`end:${t}:${u}`); },
    updateMember: async (t, u, p) => { log.push(`member:${u}:${JSON.stringify(p)}`); },
    updateTeam: async (t, p) => { log.push(`team:${JSON.stringify(p)}`); }, archiveTeam: async t => { log.push(`archive:${t}`); },
    leads: async u => o.leads?.[u] ?? [],
    offers: async u => (u === "a" ? { listings: 5, open: 2, openCents: 200_000_000, accepted: 2, acceptedCents: 100_000_000, rejected: 2 } : u === "b" ? { listings: 1, open: 0, openCents: 0, accepted: 0, acceptedCents: 0, rejected: 0 } : { listings: 0, open: 0, openCents: 0, accepted: 0, acceptedCents: 0, rejected: 0 }),
    listings: async () => [{ listingId: "l1", title: "Queenslander", agentId: "a" }, { listingId: "l2", title: "Unit", agentId: "b" }],
    tasks: async () => tasks,
    addTask: async (t, k) => { log.push(`task:${JSON.stringify(k)}`); tasks = [...tasks, { id: "k9", title: k.title, assigneeId: k.assigneeId, createdBy: k.createdBy, status: "open" }]; },
    setTaskStatus: async (...a) => { log.push(`status:${a[1]}:${a[2]}`); },
    personaName: async () => "Elena"
  };
  return { d, log };
}

describe("commission split", () => {
  it("splits gross commission between agent and team in whole cents", () => {
    expect(commissionSplit(100_000_000, 200, 6000)).toEqual({ grossCents: 2_000_000, agentCents: 1_200_000, teamCents: 800_000, agentShareBps: 6000 });
    const odd = commissionSplit(10_001, 250, 3333);
    expect(odd.agentCents + odd.teamCents).toBe(odd.grossCents);
    expect(commissionSplit(0, 200, 5000).grossCents).toBe(0);
  });
});

describe("access and visibility", () => {
  it("hides teams from non-members and non-agents", async () => {
    const { d } = world();
    expect(await getTeam(d, act("x"), "t1")).toMatchObject({ ok: false, code: "not_found" });
    expect(await getTeam(d, { userId: "o1", userType: "owner" }, "t1")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await getTeam(d, act("unlicensed"), "t1")).toMatchObject({ ok: false, code: "forbidden" });
  });
  it("shows the principal everything and a plain agent only totals and their own row", async () => {
    const { d } = world();
    const p = await getTeam(d, act("p"), "t1");
    if (!p.ok) throw new Error(p.message);
    expect(p.value.dashboard.members.map(m => m.userId)).toEqual(["p", "m", "a", "b"]);
    expect(p.value.dashboard.totals.commission).toMatchObject({ grossCents: 2_000_000, agentCents: 1_000_000, teamCents: 1_000_000 });
    expect(p.value.team.commissionRateBps).toBe(200);
    const m = await getTeam(d, act("m"), "t1");
    if (!m.ok) throw new Error(m.message);
    expect(m.value.dashboard.members.map(r => r.userId)).toEqual(["p", "m", "a", "b"]);
    expect(m.value.dashboard.totals.commission).toBeUndefined();
    expect(m.value.dashboard.members.every(r => r.commission === undefined || r.userId === "m")).toBe(true);
    expect(m.value.team.commissionRateBps).toBeUndefined();
    const a = await getTeam(d, act("a"), "t1");
    if (!a.ok) throw new Error(a.message);
    expect(a.value.dashboard.members.map(r => r.userId)).toEqual(["a"]);
    expect(a.value.dashboard.members[0]!.commission).toMatchObject({ agentCents: 1_000_000 });
    expect(a.value.dashboard.totals.members).toBe(4);
    expect(a.value.dashboard.totals.commission).toBeUndefined();
    expect(a.value.roster.find(r => r.userId === "p")!.agentShareBps).toBe(0);
    expect(a.value.roster.find(r => r.userId === "a")!.agentShareBps).toBe(5000);
    expect(a.value.listings.map(l => l.listingId)).toEqual(["l1"]);
  });
});

describe("members", () => {
  it("creates a team once per agent", async () => {
    const { d, log } = world();
    expect(await createTeam(d, act("x"), { name: " New  Team " })).toEqual({ ok: true, value: { id: "t2" } });
    expect(log).toContain("create:New Team:x");
    expect(await createTeam(d, act("a"), { name: "Second" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await createTeam(d, act("x"), { name: "x" })).toMatchObject({ ok: false, code: "invalid" });
  });
  it("invites only licensed agents who are free, and only as the role the inviter may grant", async () => {
    const { d, log } = world();
    expect(await inviteMember(d, act("a"), "t1", { email: "x@example.test" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await inviteMember(d, act("m"), "t1", { email: "x@example.test", role: "manager" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await inviteMember(d, act("m"), "t1", { email: "nobody@example.test" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await inviteMember(d, act("m"), "t1", { email: "nolicence@example.test" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await inviteMember(d, act("m"), "t1", { email: "a@example.test" })).toMatchObject({ ok: false, code: "conflict" });
    expect(await inviteMember(d, act("m"), "t1", { email: "bad" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await inviteMember(d, act("p"), "t1", { email: "X@Example.test", role: "manager" })).toEqual({ ok: true, value: { name: "Xi" } });
    expect(log).toContain("invite:t1|x|manager|p");
  });
  it("lets the invited agent accept or decline, and nobody else", async () => {
    const { d, log } = world();
    await inviteMember(d, act("p"), "t1", { email: "x@example.test" });
    expect(await respondToInvitation(d, act("a"), "t1", { accept: true })).toMatchObject({ ok: false, code: "not_found" });
    expect(await respondToInvitation(d, act("x"), "t1", { accept: "yes" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await respondToInvitation(d, act("x"), "t1", { accept: true })).toEqual({ ok: true, value: { joined: true } });
    expect(log).toContain("activate:t1:x");
    expect(await respondToInvitation(d, act("x"), "t1", { accept: false })).toMatchObject({ ok: true });
    expect((await getMyTeams(world().d, act("x")))).toEqual({ ok: true, value: { invitations: [] } });
  });
  it("lets only the principal change roles, splits and the rate", async () => {
    const { d, log } = world();
    expect(await updateMember(d, act("m"), "t1", "a", { agentSharePercent: 80 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateMember(d, act("p"), "t1", "a", { agentSharePercent: 80, role: "manager" })).toEqual({ ok: true, value: true });
    expect(log).toContain('member:a:{"role":"manager","agentShareBps":8000}');
    expect(await updateMember(d, act("p"), "t1", "a", { agentSharePercent: 101 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await updateMember(d, act("p"), "t1", "p", { role: "agent" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateMember(d, act("p"), "t1", "nobody", { role: "agent" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateTeam(d, act("m"), "t1", { commissionRatePercent: 3 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await updateTeam(d, act("p"), "t1", { commissionRatePercent: 11 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await updateTeam(d, act("p"), "t1", { commissionRatePercent: 2.75, name: "Harbour" })).toEqual({ ok: true, value: true });
    expect(log).toContain('team:{"name":"Harbour","commissionRateBps":275}');
  });
  it("limits who can remove whom, lets anyone but the principal leave, and lets the principal close the team", async () => {
    const { d, log } = world();
    expect(await removeMember(d, act("a"), "t1", "b")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await removeMember(d, act("m"), "t1", "p")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await removeMember(d, act("m"), "t1", "m")).toEqual({ ok: true, value: true });
    expect(await removeMember(d, act("b"), "t1", "b")).toEqual({ ok: true, value: true });
    expect(await removeMember(d, act("m"), "t1", "a")).toEqual({ ok: true, value: true });
    expect(await removeMember(d, act("p"), "t1", "p")).toMatchObject({ ok: false, code: "forbidden" });
    expect(log.filter(l => l.startsWith("end:"))).toEqual(["end:t1:m", "end:t1:b", "end:t1:a"]);
    expect(await archiveTeam(d, act("m"), "t1")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await archiveTeam(d, act("p"), "t1")).toEqual({ ok: true, value: true });
  });
});

describe("tasks", () => {
  it("lets managers assign to anyone and agents only to themselves, to members and team listings only", async () => {
    const { d, log } = world();
    expect(await assignTask(d, act("m"), "t1", { title: "Call buyers", assigneeId: "a", listingId: "l1", dueOn: "2026-11-10" })).toEqual({ ok: true, value: true });
    expect(log.at(-1)).toBe('task:{"title":"Call buyers","assigneeId":"a","createdBy":"m","listingId":"l1","dueOn":"2026-11-10"}');
    expect(await assignTask(d, act("a"), "t1", { title: "Mine" })).toEqual({ ok: true, value: true });
    expect(await assignTask(d, act("a"), "t1", { title: "Yours", assigneeId: "b" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await assignTask(d, act("m"), "t1", { title: "Outsider", assigneeId: "x" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await assignTask(d, act("m"), "t1", { title: "Bad listing", assigneeId: "a", listingId: "other" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await assignTask(d, act("m"), "t1", { title: "", assigneeId: "a" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await assignTask(d, act("m"), "t1", { title: "Date", assigneeId: "a", dueOn: "tomorrow" })).toMatchObject({ ok: false, code: "invalid" });
  });
  it("lets the assignee or a manager update a task and hides other agents' tasks", async () => {
    const tasks: TaskFact[] = [{ id: "k1", title: "A's", assigneeId: "a", createdBy: "m", status: "open" }, { id: "k2", title: "B's", assigneeId: "b", createdBy: "m", status: "open" }];
    const { d, log } = world({ tasks });
    expect(await updateTask(d, act("a"), "t1", "k1", { status: "done" })).toEqual({ ok: true, value: true });
    expect(await updateTask(d, act("a"), "t1", "k2", { status: "done" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await updateTask(d, act("m"), "t1", "k2", { status: "done" })).toEqual({ ok: true, value: true });
    expect(await updateTask(d, act("m"), "t1", "k2", { status: "later" })).toMatchObject({ ok: false, code: "invalid" });
    expect(log).toEqual(["status:k1:done", "status:k2:done"]);
    const a = await getTeam(d, act("a"), "t1");
    expect(a.ok && a.value.tasks.map(t => t.id)).toEqual(["k1"]);
  });
});

describe("assistant", () => {
  const lead = (o: Partial<LeadFact>): LeadFact => ({ enquiryId: "e", listingId: "l1", listingTitle: "Q", buyerId: "x", buyerName: "Sam", enquiredAt: "2026-11-01T00:00:00Z", buyerMessages: 1, agentMessages: 0, notes: 0, lastBuyerAt: "2026-11-04T00:00:00Z", ...o });
  const busy = () => world({
    leads: { a: [lead({ enquiryId: "e1" }), lead({ enquiryId: "e2" }), lead({ enquiryId: "e3" })] },
    tasks: [{ id: "k1", title: "Overdue call", assigneeId: "a", createdBy: "m", dueOn: "2026-11-01", status: "open" }]
  });
  it("gives managers evidence-based suggestions that name who and why", async () => {
    const r = await askTeamAssistant(busy().d, act("m"), "t1", { question: "What should we improve?" });
    if (!r.ok) throw new Error(r.message);
    expect(r.value.topic).toBe("suggestions");
    expect(r.value.insights?.map(i => i.kind)).toEqual(expect.arrayContaining(["replies", "workload", "tasks"]));
    expect(r.value.text).toContain("Alex has 3 buyers waiting for a first reply");
    expect(r.value.text).toContain("owners decide who is appointed");
  });
  it("keeps team-wide advice and commission away from plain agents, and gives principals the split", async () => {
    const { d } = busy();
    const a = await askTeamAssistant(d, act("a"), "t1", { question: "What should we improve?" });
    expect(a.ok && a.value.text).toContain("for the principal and managers");
    const own = await askTeamAssistant(d, act("a"), "t1", { question: "What is my commission?" });
    expect(own.ok && own.value.text).toContain("$10,000");
    const m = await askTeamAssistant(d, act("m"), "t1", { question: "commission split?" });
    expect(m.ok && m.value.text).not.toContain("kept by the team");
    const p = await askTeamAssistant(d, act("p"), "t1", { question: "commission split?" });
    expect(p.ok && p.value.text).toContain("$20,000");
    expect(p.ok && p.value.text).toContain("estimate");
  });
  it("answers performance and task questions and rejects empty or non-member asks", async () => {
    const { d } = busy();
    const perf = await askTeamAssistant(d, act("p"), "t1", { question: "How is the team performing?" });
    expect(perf.ok && perf.value.text).toContain("4 active members");
    const tasks = await askTeamAssistant(d, act("m"), "t1", { question: "Who has overdue tasks?" });
    expect(tasks.ok && tasks.value.text).toContain("Alex (1)");
    expect(await askTeamAssistant(d, act("p"), "t1", { question: "  " })).toMatchObject({ ok: false, code: "invalid" });
    expect(await askTeamAssistant(d, act("x"), "t1", { question: "hi" })).toMatchObject({ ok: false, code: "not_found" });
  });
  it("says so when there is too little activity", async () => {
    const r = await askTeamAssistant(world().d, act("p"), "t1", { question: "suggest improvements" });
    expect(r.ok && r.value.text).toContain("not enough activity");
  });
});
