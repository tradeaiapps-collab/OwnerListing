import { describe, expect, it } from "vitest";
import type { DashboardRow } from "../src/domain/agency-insights";
import type { AgencyTeamRepository, TeamMember } from "../src/domain/agency-team";
import type { OfferFact, ReportFacts } from "../src/domain/agent-reports";
import type { LeadFact } from "../src/domain/agent-workspace";
import type { Actor } from "../src/domain/listing-service";
import { analyticsPeriod, buildTeamAnalytics, change, teamAnalytics, type TeamAnalyticsDeps } from "../src/domain/team-analytics";

const NOW = new Date("2026-11-05T01:00:00Z");
const TEAM = "11111111-1111-4111-8111-111111111111";
const [BOSS, AMY, BEN, OUT] = ["b0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002", "c0000000-0000-4000-8000-000000000003", "e0000000-0000-4000-8000-000000000005"];
const actor = (id: string): Actor => ({ userId: id, userType: "agent" });
const lead = (o: Partial<LeadFact> & { enquiryId: string }): LeadFact => ({ listingId: "l1", listingTitle: "L", buyerId: "x", buyerName: "Sam Secret", enquiredAt: "2026-10-20T02:00:00Z", buyerMessages: 1, agentMessages: 1, notes: 0, ...o });
const offer = (o: Partial<OfferFact>): OfferFact => ({ listingId: "l1", listingTitle: "L", status: "accepted", priceCents: 100_000_000, submittedAt: "2026-10-22T00:00:00Z", ...o });
const row = (userId: string, displayName: string, o: Partial<DashboardRow> = {}): DashboardRow => ({
  userId, displayName, role: "agent", activeListings: 2, openTasks: 0, overdueTasks: 0, doneLast30: 1, owedCents: 0, paidCents: 0, recordedCents: 0, oldestUnpaidAt: null, ...o
});
const mem = (userId: string, displayName: string, role = "agent") => ({ userId, displayName, role });

describe("team analytics numbers", () => {
  const facts = new Map<string, ReportFacts>([
    [AMY, { leads: [lead({ enquiryId: "e1" })], offers: [offer({}), offer({ listingId: "l2", submittedAt: "2026-09-15T00:00:00Z", priceCents: 50_000_000 }), offer({ listingId: "l4", status: "rejected", submittedAt: "2026-08-01T00:00:00Z" })] }],
    [BEN, { leads: [lead({ enquiryId: "e1" }), lead({ enquiryId: "e2", listingId: "l3" })], offers: [offer({}), offer({ listingId: "l3", status: "submitted", priceCents: 70_000_000 })] }]
  ]);
  const a = buildTeamAnalytics({
    team: { id: TEAM, name: "North" }, members: [mem(AMY, "Amy"), mem(BEN, "Ben")], facts, today: "2026-11-05", now: NOW, period: { days: 90 }, listedNow: 3,
    dashboard: [row(AMY, "Amy", { owedCents: 20_000 }), row(BEN, "Ben", { overdueTasks: 1, openTasks: 2, owedCents: 5_000 })],
    commissions: [{ memberUserId: AMY, grossCents: 1_000_000, memberCents: 700_000, officeCents: 300_000, entries: 1 }]
  });

  it("totals the team once for a shared listing, and each agent on their own", () => {
    expect(a.overview).toMatchObject({ listedNow: 3, enquiries: { current: 2 }, offers: { current: 3 }, sold: { current: 2, previous: 0 }, soldCents: { current: 150_000_000 } });
    expect(a.agents.map(x => [x.displayName, x.sold, x.soldCents])).toEqual([["Amy", 2, 150_000_000], ["Ben", 1, 100_000_000]]);
    expect(a.agents[0]!).toMatchObject({ commissionGrossCents: 1_000_000, commissionAgentCents: 700_000, activeListings: 2 });
    expect(a.overview).toMatchObject({ commissionGrossCents: 1_000_000, commissionAgentCents: 700_000, commissionOfficeCents: 300_000, commissionOwedCents: 25_000, overdueTasks: 1 });
  });
  it("spreads accepted offers over the months of the period", () => {
    expect(a.trends.buckets.at(-1)).toBe("2026-11-01");
    const idx = (b: string) => a.trends.buckets.indexOf(b);
    expect(a.trends.sold[idx("2026-10-01")]).toBe(1);
    expect(a.trends.sold[idx("2026-09-01")]).toBe(1);
    expect(a.trends.soldCents[idx("2026-10-01")]).toBe(100_000_000);
    expect(a.trends.perAgent.map(x => [x.displayName, x.total])).toEqual([["Amy", 150_000_000], ["Ben", 100_000_000]]);
    expect(a.trends.sold.reduce((s, v) => s + v, 0)).toBe(2);
  });
  it("writes a plain summary and never includes buyer names", () => {
    expect(a.summary).toContain("North had 2 accepted offers worth $1,500,000");
    expect(JSON.stringify(a)).not.toContain("Sam Secret");
  });
  it("only changes by percent against a non-zero earlier figure", () => {
    expect(change(12, 10)).toEqual({ current: 12, previous: 10, changePct: 20 });
    expect(change(3, 0)).toEqual({ current: 3, previous: 0 });
  });
});

describe("team analytics alerts", () => {
  const base = { team: { id: TEAM, name: "North" }, today: "2026-11-05", now: NOW, period: { days: 90 as const }, listedNow: 2, commissions: [] };
  const alerts = (members: ReturnType<typeof mem>[], facts: Map<string, ReportFacts>, dashboard: DashboardRow[]) =>
    buildTeamAnalytics({ ...base, members, facts, dashboard }).alerts;

  it("flags overdue tasks, waiting buyers and enquiries that never become offers", () => {
    const quiet: ReportFacts = { leads: Array.from({ length: 5 }, (_, n) => lead({ enquiryId: `q${n}`, buyerMessages: 1, agentMessages: 0 })), offers: [] };
    const out = alerts([mem(AMY, "Amy"), mem(BEN, "Ben")], new Map([[AMY, quiet], [BEN, { leads: [], offers: [] }]]), [row(AMY, "Amy", { openTasks: 4, overdueTasks: 3 }), row(BEN, "Ben")]);
    expect(out.map(x => x.kind)).toEqual(expect.arrayContaining(["overdue_tasks", "waiting_buyers", "no_offers"]));
    expect(out[0]!.severity).toBe("high");
    expect(out.filter(x => x.kind === "no_offers").map(x => x.memberUserId)).toEqual([AMY]);
  });
  it("flags an agent whose offers are accepted far less often than the team's, but only with enough decided offers", () => {
    const decided = (n: number, status: string): OfferFact[] => Array.from({ length: n }, (_, i) => offer({ listingId: `x${status}${n}${i}`, status }));
    const strong: ReportFacts = { leads: [], offers: decided(5, "accepted") };
    const weak: ReportFacts = { leads: [], offers: [...decided(1, "accepted"), ...decided(4, "rejected")] };
    const out = alerts([mem(AMY, "Amy"), mem(BEN, "Ben")], new Map([[AMY, strong], [BEN, weak]]), [row(AMY, "Amy"), row(BEN, "Ben")]);
    expect(out.find(x => x.kind === "low_acceptance")).toMatchObject({ memberUserId: BEN });
    const few: ReportFacts = { leads: [], offers: [...decided(1, "accepted"), ...decided(2, "rejected")] };
    expect(alerts([mem(AMY, "Amy"), mem(BEN, "Ben")], new Map([[AMY, strong], [BEN, few]]), [row(AMY, "Amy"), row(BEN, "Ben")]).some(x => x.kind === "low_acceptance")).toBe(false);
  });
  it("flags sales that halved against the period before", () => {
    const prior = Array.from({ length: 4 }, (_, i) => offer({ listingId: `p${i}`, submittedAt: "2026-04-01T00:00:00Z" }));
    const out = alerts([mem(AMY, "Amy")], new Map([[AMY, { leads: [], offers: prior }]]), [row(AMY, "Amy")]);
    expect(out.some(x => x.kind === "sales_fell")).toBe(false); // April is before the previous 90 days (10 May to 7 Aug)
    const inPrev = Array.from({ length: 4 }, (_, i) => offer({ listingId: `p${i}`, submittedAt: "2026-06-20T00:00:00Z" }));
    expect(alerts([mem(AMY, "Amy")], new Map([[AMY, { leads: [], offers: inPrev }]]), [row(AMY, "Amy")]).some(x => x.kind === "sales_fell")).toBe(true);
  });
  it("is quiet for a healthy team", () => {
    const ok: ReportFacts = { leads: [lead({ enquiryId: "h1" })], offers: [offer({})] };
    expect(alerts([mem(AMY, "Amy"), mem(BEN, "Ben")], new Map([[AMY, ok], [BEN, ok]]), [row(AMY, "Amy"), row(BEN, "Ben")])).toEqual([]);
  });
});

describe("period and permissions", () => {
  it("accepts rolling days or a real date range, and refuses the rest", () => {
    expect(analyticsPeriod(new URLSearchParams())).toEqual({ ok: true, value: { days: 90 } });
    expect(analyticsPeriod(new URLSearchParams("days=30"))).toEqual({ ok: true, value: { days: 30 } });
    expect(analyticsPeriod(new URLSearchParams("days=45"))).toMatchObject({ ok: false });
    expect(analyticsPeriod(new URLSearchParams("from=2026-01-01&to=2026-03-01"))).toEqual({ ok: true, value: { from: "2026-01-01", to: "2026-03-01" } });
    expect(analyticsPeriod(new URLSearchParams("from=2026-02-30&to=2026-03-01"))).toMatchObject({ ok: false });
    expect(analyticsPeriod(new URLSearchParams("from=2026-03-02&to=2026-03-01"))).toMatchObject({ ok: false });
    expect(analyticsPeriod(new URLSearchParams("from=2020-01-01&to=2026-03-01"))).toMatchObject({ ok: false });
  });
  it("lets only the team's manager in", async () => {
    const members: TeamMember[] = [{ userId: BOSS, displayName: "Boss", role: "manager", memberBps: null }, { userId: AMY, displayName: "Amy", role: "agent", memberBps: null }];
    const repo: Pick<AgencyTeamRepository, "getTeam" | "getMembership" | "listMembers"> = {
      getTeam: async id => (id === TEAM ? { id: TEAM, name: "North", kind: "team", defaultMemberBps: 7000 } : undefined),
      getMembership: async (_t, u) => { const m = members.find(x => x.userId === u); return m ? { role: m.role, memberBps: null } : undefined; },
      listMembers: async () => members
    };
    const seen: string[] = [];
    const d: TeamAnalyticsDeps = {
      repo, now: () => NOW, facts: async ids => { seen.push(...ids); return new Map(); }, dashboardRows: async () => [row(BOSS, "Boss", { role: "manager" }), row(AMY, "Amy")],
      commissions: async () => [], listedNow: async () => 0
    };
    expect(await teamAnalytics(d, actor(BOSS), TEAM, { days: 90 })).toMatchObject({ ok: true });
    expect(seen).toEqual([BOSS, AMY]);
    expect(await teamAnalytics(d, actor(AMY), TEAM, { days: 90 })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await teamAnalytics(d, actor(OUT), TEAM, { days: 90 })).toMatchObject({ ok: false, code: "not_found" });
  });
});
