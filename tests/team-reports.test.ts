import { describe, expect, it } from "vitest";
import type { AgencyTeamRepository, TeamMember } from "../src/domain/agency-team";
import { type OfferFact, type ReportFacts } from "../src/domain/agent-reports";
import type { LeadFact } from "../src/domain/agent-workspace";
import type { Actor } from "../src/domain/listing-service";
import { compareAgents, mergeFacts, parseTeamFilter, runTeamReport, teamDefinitionFromQuery, type TeamReportDeps } from "../src/domain/team-reports";

const NOW = new Date("2026-11-05T01:00:00Z");
const TEAM = "11111111-1111-4111-8111-111111111111";
const [BOSS, AMY, BEN, STAFF, OUT] = ["b0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "c0000000-0000-4000-8000-000000000003", "d0000000-0000-4000-8000-000000000004", "e0000000-0000-4000-8000-000000000005"];
const actor = (id: string): Actor => ({ userId: id, userType: "agent" });

const lead = (o: Partial<LeadFact> & { enquiryId: string; listingId: string }): LeadFact => ({
  listingTitle: o.listingId, buyerId: "x", buyerName: "Sam Secret", enquiredAt: "2026-10-20T02:00:00Z", buyerMessages: 1, agentMessages: 1, notes: 0, propertyType: "house", ...o
});
const offer = (o: Partial<OfferFact> & { listingId: string }): OfferFact => ({ listingTitle: o.listingId, status: "accepted", priceCents: 100_000_00, submittedAt: "2026-10-22T00:00:00Z", propertyType: "house", ...o });

const facts = new Map<string, ReportFacts>([
  [AMY, { leads: [lead({ enquiryId: "e1", listingId: "l1" }), lead({ enquiryId: "e2", listingId: "l2", propertyType: "unit" })],
    offers: [offer({ listingId: "l1", priceCents: 90_000_000 }), offer({ listingId: "l2", propertyType: "unit", status: "rejected", priceCents: 50_000_000 })] }],
  // Ben shares listing l1 with Amy: the same enquiry and the same offer arrive a second time.
  [BEN, { leads: [lead({ enquiryId: "e1", listingId: "l1", agentMessages: 0 }), lead({ enquiryId: "e3", listingId: "l3", enquiredAt: "2026-10-25T02:00:00Z", agentMessages: 0 })],
    offers: [offer({ listingId: "l1", priceCents: 90_000_000 }), offer({ listingId: "l3", status: "submitted", priceCents: 70_000_000 })] }],
  [BOSS, { leads: [], offers: [] }]
]);

const member = (userId: string, displayName: string, role: TeamMember["role"]): TeamMember => ({ userId, displayName, role, memberBps: null });
const members = [member(BOSS, "Boss", "manager"), member(AMY, "Amy", "agent"), member(BEN, "Ben", "agent"), member(STAFF, "Sam Staff", "staff")];
const repo: Pick<AgencyTeamRepository, "getTeam" | "getMembership" | "listMembers"> = {
  getTeam: async id => (id === TEAM ? { id: TEAM, name: "North office", kind: "office", defaultMemberBps: 7000 } : undefined),
  getMembership: async (t, u) => { const m = t === TEAM ? members.find(x => x.userId === u) : undefined; return m ? { role: m.role, memberBps: null } : undefined; },
  listMembers: async () => members
};
const asked: string[][] = [];
const deps: TeamReportDeps = { repo, now: () => NOW, facts: async ids => { asked.push(ids); return new Map(ids.map(i => [i, facts.get(i) ?? { leads: [], offers: [] }])); } };
const req = (q: string) => (m: Parameters<Parameters<typeof runTeamReport>[3]>[0]) => {
  const p = new URLSearchParams(q);
  const def = teamDefinitionFromQuery(p); if (!def.ok) return def;
  const f = parseTeamFilter(p.get("agents"), p.get("propertyType"), m); if (!f.ok) return f;
  return { ok: true as const, value: { definition: def.value, filter: f.value } };
};

describe("who may run a team report", () => {
  it("lets a manager in, shows outsiders 404, and keeps non-managers out", async () => {
    expect(await runTeamReport(deps, actor(BOSS), TEAM, req(""))).toMatchObject({ ok: true });
    expect(await runTeamReport(deps, actor(OUT), TEAM, req(""))).toMatchObject({ ok: false, code: "not_found" });
    expect(await runTeamReport(deps, actor(BOSS), "not-a-uuid", req(""))).toMatchObject({ ok: false, code: "not_found" });
    expect(await runTeamReport(deps, actor(AMY), TEAM, req(""))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await runTeamReport(deps, actor(STAFF), TEAM, req(""))).toMatchObject({ ok: false, code: "forbidden" });
  });
  it("only loads facts for agents on this team, and never for staff", async () => {
    asked.length = 0;
    await runTeamReport(deps, actor(BOSS), TEAM, req(""));
    expect(asked[0]).toEqual([BOSS, AMY, BEN]);
    asked.length = 0;
    await runTeamReport(deps, actor(BOSS), TEAM, req(`agents=${AMY}`));
    expect(asked[0]).toEqual([AMY]);
  });
});

describe("filters", () => {
  it("refuses agents from other teams and unknown property types, never ignoring them", () => {
    const m = members.map(x => ({ userId: x.userId, displayName: x.displayName }));
    expect(parseTeamFilter(OUT, null, m)).toMatchObject({ ok: false });
    expect(parseTeamFilter("nope", null, m)).toMatchObject({ ok: false });
    expect(parseTeamFilter(AMY, "castle", m)).toMatchObject({ ok: false });
    expect(parseTeamFilter(`${AMY},${AMY},${BEN}`, "unit", m)).toEqual({ ok: true, value: { agents: [AMY, BEN], propertyType: "unit" } });
    expect(parseTeamFilter(null, null, m)).toEqual({ ok: true, value: { agents: [] } });
  });
  it("defaults to the sales template with a row per agent", () => {
    const d = teamDefinitionFromQuery(new URLSearchParams());
    expect(d).toMatchObject({ ok: true, value: { template: "sales", groupBy: "none" } });
    expect(teamDefinitionFromQuery(new URLSearchParams("groupBy=month"))).toMatchObject({ ok: true, value: { groupBy: "month" } });
    expect(teamDefinitionFromQuery(new URLSearchParams("groupBy=buyer"))).toMatchObject({ ok: false });
  });
  it("counts only the chosen property type", async () => {
    const r = await runTeamReport(deps, actor(BOSS), TEAM, req("propertyType=unit"));
    if (!r.ok) throw new Error("run");
    expect(r.value.report.totals).toMatchObject({ offers: 1, rejected: 1, accepted: 0 });
    expect(r.value.insights.points.join(" ")).toContain("Only unit listings are counted");
  });
});

describe("team report numbers", () => {
  it("counts a listing shared by two agents once in the total, and gives each agent their own row", async () => {
    const r = await runTeamReport(deps, actor(BOSS), TEAM, req("template=sales"));
    if (!r.ok) throw new Error("run");
    const { report } = r.value;
    expect(report.groupLabel).toBe("Agent");
    expect(report.totals).toMatchObject({ offers: 3, accepted: 1, rejected: 1, accepted_cents: 90_000_000 }); // 4 offer rows, the shared one once
    const amy = report.rows.find(x => x.label === "Amy")!, ben = report.rows.find(x => x.label === "Ben")!;
    expect(amy.values).toMatchObject({ offers: 2, accepted: 1, accepted_cents: 90_000_000 });
    expect(ben.values).toMatchObject({ offers: 2, accepted: 1 });
    expect(report.rows[0]!.values.accepted_cents).toBe(90_000_000); // best seller first
    expect(report.rows.map(x => x.label)).not.toContain("Sam Staff");
  });
  it("can group the team total by listing or month while keeping the agent rows", async () => {
    const r = await runTeamReport(deps, actor(BOSS), TEAM, req("groupBy=listing"));
    if (!r.ok) throw new Error("run");
    expect(r.value.report.groupLabel).toBe("Listing");
    expect(r.value.report.rows.map(x => x.key).sort()).toEqual(["l1", "l2", "l3"]);
    expect(r.value.agentRows).toHaveLength(3);
    const m = await runTeamReport(deps, actor(BOSS), TEAM, req("groupBy=month&days=90"));
    if (!m.ok) throw new Error("run");
    expect(m.value.report.groupLabel).toBe("Month");
  });
  it("never leaks buyer names", async () => {
    const r = await runTeamReport(deps, actor(BOSS), TEAM, req("template=leads"));
    expect(JSON.stringify(r)).not.toContain("Sam Secret");
  });
  it("merges duplicate enquiries toward the earlier agent reply", () => {
    const a = lead({ enquiryId: "e", listingId: "l", firstAgentAt: "2026-10-20T05:00:00Z" });
    const b = lead({ enquiryId: "e", listingId: "l", firstAgentAt: "2026-10-20T03:00:00Z" });
    const c = lead({ enquiryId: "e", listingId: "l", agentMessages: 0 });
    for (const order of [[a, b, c], [c, a, b], [b, c, a]]) {
      expect(mergeFacts(order.map(l => ({ leads: [l], offers: [] }))).leads[0]!.firstAgentAt).toBe("2026-10-20T03:00:00Z");
    }
  });
});

describe("agent against agent", () => {
  it("picks the better figure per measure, and the lower one for reply time", async () => {
    const r = await runTeamReport(deps, actor(BOSS), TEAM, req(`template=leads&agents=${AMY},${BEN}`));
    if (!r.ok) throw new Error("run");
    const v = r.value.versus!;
    expect([v.a.displayName, v.b.displayName]).toEqual(["Amy", "Ben"]);
    expect(v.rows.find(x => x.key === "awaiting_reply")).toMatchObject({ a: 0, b: 2, leader: "a" }); // fewer waiting buyers wins
    expect(v.rows.find(x => x.key === "enquiries")).toMatchObject({ a: 2, b: 2, leader: "tie" });
  });
  it("has no leader when one side has no figure, and no comparison unless exactly two agents are chosen", async () => {
    const r = await runTeamReport(deps, actor(BOSS), TEAM, req(`template=performance&agents=${AMY},${BEN}`));
    if (!r.ok) throw new Error("run");
    const rows = r.value.agentRows;
    const v = compareAgents(r.value.report, rows, { userId: AMY, displayName: "Amy" }, { userId: "ghost", displayName: "Ghost" });
    expect(v.rows.every(x => x.leader === null)).toBe(true);
    const one = await runTeamReport(deps, actor(BOSS), TEAM, req(`agents=${AMY}`));
    if (!one.ok) throw new Error("run");
    expect(one.value.versus).toBeUndefined();
  });
});

describe("Elena's team notes", () => {
  it("names the leader and agents with enquiries but no offers", async () => {
    const quiet = new Map(facts);
    quiet.set(BEN, { leads: Array.from({ length: 5 }, (_, n) => lead({ enquiryId: `q${n}`, listingId: "lq", agentMessages: 0 })), offers: [] });
    const r = await runTeamReport({ ...deps, facts: async ids => new Map(ids.map(i => [i, quiet.get(i) ?? { leads: [], offers: [] }])) }, actor(BOSS), TEAM, req("template=pipeline&groupBy=none"));
    if (!r.ok) throw new Error("run");
    const text = r.value.insights.points.join(" | ");
    expect(text).toContain("Ben had 5 enquiries and no offers");
    expect(text).toContain("Ben has 5 buyers waiting for a first reply");
  });
  it("says so when no listing of the chosen type exists", async () => {
    const r = await runTeamReport(deps, actor(BOSS), TEAM, req("propertyType=land"));
    if (!r.ok) throw new Error("run");
    expect(r.value.report.totals).toMatchObject({ offers: 0 });
    expect(r.value.insights.points.join(" ")).toContain("Only land listings are counted");
  });
});
