import { describe, expect, it, vi } from "vitest";
import { agentLabel, buildInsights, trend, type AgentFact, type AreaFact, type InsightFacts, type PeriodCounts } from "../src/domain/admin-elena-insights";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, loads: 0 }));
vi.mock("../src/server/context", () => ({ getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => undefined }));
vi.mock("../src/server/assistant-persona-db", () => ({ loadLivePersona: async () => "elena" }));
vi.mock("../src/server/admin-elena-insights-db", () => ({
  loadInsightFacts: async () => { state.loads++; return facts({}); }
}));
import * as route from "../app/api/staff/elena-insights/route";

const admin: StaffActor = { id: "a", role: "super_admin" };
const reporting: StaffActor = { id: "r", role: "reporting" };
const accountant: StaffActor = { id: "c", role: "accountant" };
const support: StaffActor = { id: "s", role: "support" };

const pc = (o: Partial<PeriodCounts> = {}): PeriodCounts => ({ listings: 0, enquiries: 0, offers: 0, accepted: 0, decided: 0, ...o });
const agent = (o: Partial<AgentFact> & { id: string }): AgentFact => ({ name: "Jane Citizen", listings: 2, enquiries: 10, unanswered: 0, offers: 4, accepted: 2, decided: 4, medianResponseMinutes: 30, ...o });
const area = (o: Partial<AreaFact> & { suburb: string }): AreaFact => ({ jurisdiction: "QLD", current: pc(), previous: pc(), publishedNow: 0, ...o });
function facts(o: Partial<InsightFacts>): InsightFacts {
  return { current: pc({ enquiries: 40, offers: 10, accepted: 5, decided: 10, listings: 8 }), previous: pc({ enquiries: 30, offers: 8, accepted: 4, decided: 8, listings: 6 }), areas: [], agents: [], ...o };
}

describe("trend and names", () => {
  it("gives a percentage change only against a non-zero previous period", () => {
    expect(trend(12, 10)).toEqual({ current: 12, previous: 10, changePct: 20 });
    expect(trend(5, 0)).toEqual({ current: 5, previous: 0 });
  });
  it("shows agent names as the personal-data permission allows", () => {
    expect(agentLabel(admin, "Jane Citizen", 0)).toBe("Jane Citizen");
    expect(agentLabel(accountant, "Jane Citizen", 0)).toBe("Jane C.");
    expect(agentLabel(reporting, "Jane Citizen", 2)).toBe("Agent 3");
  });
});

describe("insights rules", () => {
  it("summarises the period and the platform rates", () => {
    const i = buildInsights(admin, facts({}));
    expect(i.platform).toMatchObject({ acceptanceRate: 50, offersPerEnquiryPct: 25, enquiries: { current: 40, previous: 30, changePct: 33 } });
    expect(i.summary).toContain("40 enquiries, up 33%");
    expect(i.alerts).toEqual([]);
    expect(i.recommendations[0]).toMatch(/Nothing stands out/);
  });
  it("does not give an acceptance rate or flag agents on small samples", () => {
    const i = buildInsights(admin, facts({ current: pc({ enquiries: 4, offers: 2, accepted: 0, decided: 2 }), agents: [agent({ id: "1", accepted: 0, decided: 3, enquiries: 3, medianResponseMinutes: 900 })] }));
    expect(i.platform.acceptanceRate).toBeUndefined();
    expect(i.alerts).toEqual([]);
    expect(i.agents[0]).toMatchObject({ note: expect.stringContaining("no rate") });
    expect(i.agents[0]).not.toHaveProperty("rank");
  });
  it("ranks agents by acceptance and flags a low rate, slow replies and unanswered enquiries", () => {
    const i = buildInsights(admin, facts({ agents: [
      agent({ id: "1", name: "Ann A", accepted: 4, decided: 5 }), agent({ id: "2", name: "Bob B", accepted: 3, decided: 5 }),
      agent({ id: "3", name: "Cy C", accepted: 0, decided: 6, medianResponseMinutes: 120, unanswered: 4 })
    ] }));
    expect(i.agents.map(a => [a.label, a.rank])).toEqual([["Ann A", 1], ["Bob B", 2], ["Cy C", 3]]);
    const ids = i.alerts.map(a => a.id);
    expect(ids).toEqual(["agent-unanswered-3", "agent-rate-3", "agent-resp-3"]);
    expect(i.alerts[0]!.severity).toBe("high");
    expect(i.recommendations.length).toBeGreaterThanOrEqual(3);
  });
  it("hides agent identity from staff without personal-data permission, including in alerts", () => {
    const i = buildInsights(reporting, facts({ agents: [agent({ id: "9", name: "Secret Person", unanswered: 5 })] }));
    expect(JSON.stringify(i)).not.toContain("Secret");
    expect(i.alerts[0]!.message).toContain("Agent 1");
  });
  it("flags areas with a conversion gap, an enquiry drop, or live listings and no enquiries", () => {
    const i = buildInsights(admin, facts({ areas: [
      area({ suburb: "paddington", current: pc({ enquiries: 10, offers: 0 }), previous: pc({ enquiries: 8 }) }),
      area({ suburb: "milton", current: pc({ enquiries: 2 }), previous: pc({ enquiries: 10 }) }),
      area({ suburb: "toowong", publishedNow: 4 })
    ] }));
    expect(i.alerts.map(a => a.id).sort()).toEqual(["area-conv-QLD-paddington", "area-drop-QLD-milton", "area-quiet-QLD-toowong"]);
    expect(i.alerts.find(a => a.id === "area-drop-QLD-milton")).toMatchObject({ severity: "high", subject: "Milton QLD" });
    expect(i.areas[0]!.area).toBe("Paddington QLD");
  });
  it("still flags a quiet area that falls outside the 25 busiest", () => {
    const many = Array.from({ length: 30 }, (_, n) => area({ suburb: `s${String(n).padStart(2, "0")}`, current: pc({ enquiries: 100 - n }) }));
    const i = buildInsights(admin, facts({ areas: [...many, area({ suburb: "zzz", publishedNow: 3 })] }));
    expect(i.areas).toHaveLength(25);
    expect(i.alerts.map(a => a.id)).toContain("area-quiet-QLD-zzz");
  });
  it("recommends more agents where demand is rising", () => {
    const i = buildInsights(admin, facts({ areas: [area({ suburb: "bulimba", current: pc({ enquiries: 12 }), previous: pc({ enquiries: 6 }) })] }));
    expect(i.recommendations.join(" ")).toContain("Bulimba QLD");
  });
});

describe("GET /api/staff/elena-insights", () => {
  const call = () => route.GET(new Request("http://x/api/staff/elena-insights?from=2026-10-01&to=2026-10-20"));
  it("needs a signed-in staff member with the sales report permission", async () => {
    state.loads = 0;
    state.staff = null;
    expect((await call()).status).toBe(401);
    state.staff = support;
    expect((await call()).status).toBe(403);
    expect(state.loads).toBe(0);
  });
  it("returns insights with the live persona's name", async () => {
    state.staff = reporting;
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.persona).toBe("Elena");
    expect(body.range).toMatchObject({ from: "2026-10-01", to: "2026-10-20" });
    expect(body.insights.platform.enquiries.current).toBe(40);
  });
  it("rejects bad dates", async () => {
    state.staff = admin;
    expect((await route.GET(new Request("http://x/a?from=2026-10-30&to=2026-10-01"))).status).toBe(400);
  });
});

describe("team insights", () => {
  const team = (id: string, o: Record<string, unknown> = {}) => ({ id, name: `Team ${id}`, kind: "team", members: 3, activeListings: 2, overdueTasks: 0, current: { enquiries: 0, offers: 0, accepted: 0, acceptedCents: 9, commissionCents: 9 }, previous: { enquiries: 0, offers: 0, accepted: 0, acceptedCents: 0, commissionCents: 0 }, ...o });
  it("compares teams with counts only and adds their alerts and a recommendation", () => {
    const i = buildInsights(admin, facts({ teams: [
      team("A", { current: { enquiries: 12, offers: 5, accepted: 3, acceptedCents: 5_000_000, commissionCents: 1 } }),
      team("Q", { activeListings: 4 })
    ] }));
    expect(i.teams!.map(t => t.name)).toEqual(["Team A", "Team Q"]);
    expect(JSON.stringify(i.teams)).not.toMatch(/soldCents|commissionCents/); // Elena's admin view is counts only
    expect(i.alerts.find(a => a.kind === "team")).toMatchObject({ id: "team-quiet-Q", severity: "high" });
    expect(i.recommendations.join(" ")).toContain("live listings but few enquiries");
    expect(i.teamNote).toContain("teams below");
  });
  it("keeps working when no teams exist, with the old agent-only comparison", () => {
    const i = buildInsights(admin, facts({}));
    expect(i.teams).toBeUndefined();
    expect(i.teamNote).toContain("No agency teams");
  });
});
