import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBenchmark, experienceBand, metricsFor, parsePeriodDays, peerGroup, percentile, periods, priceBand, type AgentMetricFacts
} from "../src/domain/agent-benchmark";
import { addMonths, buildForecastView, forecastSegment, parseSegment, segmentOptions, tQuantile, type SaleFact } from "../src/domain/area-forecast";
import { buildTeamTrends, slope } from "../src/domain/team-trends";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, actor: null as { userId: string; userType: string } | null }));
vi.mock("../src/server/context", () => ({ getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff, getActor: async () => state.actor }));
vi.mock("../src/server/analytics-suite-db", () => ({
  loadSaleFacts: async () => [], loadAgentFacts: async () => ({ agents: [], sales: [], enquiries: [], commissions: [] }),
  listAgencyTeams: async () => [{ id: "11111111-1111-4111-8111-111111111111", name: "North office" }]
}));

import * as forecastRoute from "../app/api/staff/analytics/forecast/route";
import * as benchRoute from "../app/api/staff/analytics/benchmarks/route";
import * as trendsRoute from "../app/api/staff/analytics/trends/route";
import * as agentForecastRoute from "../app/api/agent/market-forecast/route";

const admin: StaffActor = { id: "a", role: "super_admin" };
const reporting: StaffActor = { id: "r", role: "reporting" };

/** Steady 1%-a-month growth from $800k with a small alternating wobble, 3 sales a month for 24 months. */
function growingMarket(months = 24, start = "2024-12"): SaleFact[] {
  const out: SaleFact[] = [];
  for (let i = 0; i < months; i++) {
    const base = 80_000_000 * Math.exp(0.01 * i);
    for (const k of [-1, 0, 1]) out.push({ month: addMonths(start, i), suburb: "Paddington", propertyType: "house", priceCents: Math.round(base * (1 + k * 0.03 + (i % 2 ? 0.01 : -0.01))) });
  }
  return out;
}

describe("market forecast", () => {
  it("projects a steady trend 12 months ahead with ranges that widen and contain the middle", () => {
    const f = forecastSegment(growingMarket(), { area: "paddington", propertyType: "house" }, "2026-11");
    if (f.state !== "ready") throw new Error(f.message);
    expect(f.forecast).toHaveLength(12);
    expect(f.forecast[0]!.month).toBe("2026-12");
    expect(f.forecast[11]!.month).toBe("2027-11");
    expect(f.annualChangePct).toBeGreaterThan(10);
    expect(f.annualChangePct).toBeLessThan(15); // ~12.7% for 1% a month
    for (const p of f.forecast) {
      expect(p.low95Cents).toBeLessThanOrEqual(p.low80Cents);
      expect(p.low80Cents).toBeLessThan(p.midCents);
      expect(p.high80Cents).toBeGreaterThan(p.midCents);
      expect(p.high95Cents).toBeGreaterThanOrEqual(p.high80Cents);
    }
    const width = (i: number) => f.forecast[i]!.high80Cents - f.forecast[i]!.low80Cents;
    expect(width(11)).toBeGreaterThan(width(0));
    expect(f.capped).toBe(false);
  });

  it("refuses thin segments and caps runaway trends", () => {
    const thin = forecastSegment(growingMarket(4), { area: "all", propertyType: "all" }, "2026-11");
    expect(thin).toMatchObject({ state: "unavailable", sales: 12, months: 4 });
    const boom: SaleFact[] = [];
    for (let i = 0; i < 8; i++) for (let k = 0; k < 2; k++) boom.push({ month: addMonths("2026-04", i), suburb: "X", propertyType: "unit", priceCents: 50_000_000 * 1.2 ** i });
    const f = forecastSegment(boom, { area: "all", propertyType: "unit" }, "2026-11");
    expect(f.state === "ready" && f.capped).toBe(true);
    expect(f.state === "ready" && f.annualChangePct).toBeLessThan(28);
  });

  it("ignores other segments and future months, and lists only segments with enough sales", () => {
    const facts = [...growingMarket(), { month: "2026-03", suburb: "Ascot", propertyType: "unit", priceCents: 1 }, { month: "2027-01", suburb: "Paddington", propertyType: "house", priceCents: 1 }];
    const f = forecastSegment(facts, { area: "Paddington", propertyType: "all" }, "2026-11");
    expect(f.state === "ready" && f.sales).toBe(72);
    const o = segmentOptions(facts);
    expect(o.areas.map(a => a.area)).toEqual(["Paddington"]);
    expect(o.types.map(a => a.propertyType)).toEqual(["house"]);
    expect(o.pairs).toHaveLength(1);
    expect(buildForecastView(facts, { area: "all", propertyType: "all" }, "2026-11").method).toMatch(/not a valuation/);
  });

  it("parses the segment and t quantiles", () => {
    expect(parseSegment(new URLSearchParams())).toEqual({ ok: true, segment: { area: "all", propertyType: "all" } });
    expect(parseSegment(new URLSearchParams({ type: "castle" })).ok).toBe(false);
    expect(parseSegment(new URLSearchParams({ area: "x".repeat(81) })).ok).toBe(false);
    expect(tQuantile(4, 95)).toBe(2.776);
    expect(tQuantile(200, 80)).toBe(1.2816);
    expect(addMonths("2026-11", 2)).toBe("2027-01");
  });
});

const TODAY = "2026-11-05";
function team(): AgentMetricFacts {
  const agents = ["Ava", "Ben", "Cal", "Dee", "Eve"].map((name, i) => ({
    agentId: `id-${i}`, name, firstAppointedAt: "2025-01-01T00:00:00Z", primaryArea: i < 4 ? "Paddington" : "Ascot", medianListCents: 90_000_000
  }));
  const sales = agents.flatMap((a, i) => Array.from({ length: i + 1 }, (_, k) => ({
    agentId: a.agentId, date: `2026-10-${String(10 + k).padStart(2, "0")}`, priceCents: 95_000_000, listCents: 100_000_000 - i * 1_000_000, daysOnMarket: 20 + i * 5
  })));
  sales.push({ agentId: "id-0", date: "2026-07-20", priceCents: 80_000_000, listCents: 80_000_000, daysOnMarket: 40 });
  return {
    agents, sales,
    enquiries: agents.map((a, i) => ({ agentId: a.agentId, date: "2026-10-01", enquiries: 10, converted: i })),
    commissions: agents.map(a => ({ agentId: a.agentId, date: "2026-10-15", cents: 1_000_000 }))
  };
}

describe("agent benchmarking", () => {
  it("computes metrics for a period", () => {
    const { current, previous } = periods(90, TODAY);
    expect(current).toEqual({ from: "2026-08-08", to: TODAY, days: 90 });
    expect(previous.to).toBe("2026-08-07");
    expect(metricsFor(team(), current, "id-2")).toEqual({ sales: 3, commission: 1_000_000, daysOnMarket: 30, priceToList: 96.9, conversion: 20 });
    expect(metricsFor(team(), previous, "id-0")).toEqual({ sales: 1, commission: 0, daysOnMarket: 40, priceToList: 100 });
  });

  it("ranks percentiles with ties and lower-is-better metrics", () => {
    expect(percentile(5, [1, 2, 3], true)).toBe(100);
    expect(percentile(2, [1, 2, 3], true)).toBe(50);
    expect(percentile(10, [20, 30, 40], false)).toBe(100);
    expect(percentile(10, [20, 30], true)).toBeUndefined();
  });

  it("relaxes the peer group until enough agents match", () => {
    const p = (id: string, area: string, price = "A", experience = "X") => ({ id, area, price, experience });
    const all = [p("me", "a"), p("1", "a"), p("2", "a"), p("3", "a", "B"), p("4", "b")];
    expect(peerGroup(all[0]!, all)).toEqual({ ids: ["1", "2", "3"], basis: ["area"] });
    expect(peerGroup(all[0]!, [...all, p("5", "a")])).toEqual({ ids: ["1", "2", "5"], basis: ["area", "price", "experience"] });
    expect(peerGroup(p("z", "zzz"), all).basis).toEqual([]);
    expect(priceBand(undefined)).toBe("No asking prices");
    expect(priceBand(150_000_000)).toBe("$1m to $2m");
    expect(experienceBand("2026-01-01T00:00:00Z", TODAY)).toBe("Under 1 year");
    expect(parsePeriodDays("45")).toBeUndefined();
    expect(parsePeriodDays(null)).toBe(90);
  });

  it("builds rows with peers, percentiles, trends and permission-shaped output", () => {
    const b = buildBenchmark(admin, team(), 90, TODAY);
    expect(b.rows.map(r => r.label)).toEqual(["Eve", "Dee", "Cal", "Ben", "Ava"]);
    expect(b.rows.every(r => r.key.startsWith("agent-") && !("agentId" in r))).toBe(true);
    const dee = b.rows[1]!;
    expect(dee).toMatchObject({ area: "Paddington", peerCount: 3, peerBasis: ["area", "price", "experience"], current: { sales: 4 } });
    expect(dee.percentiles.sales).toBe(100);
    expect(dee.percentiles.daysOnMarket).toBe(0); // slowest of its peers
    expect(dee.peerMedian.sales).toBe(2);
    expect(b.months).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(b.rows[4]!.monthlySales).toEqual([0, 1, 0, 0, 1, 0]);
    expect(b.metrics).toContain("commission");

    const r = buildBenchmark(reporting, team(), 90, TODAY);
    expect(r.metrics).not.toContain("commission");
    expect(r.rows[0]!.current.commission).toBeUndefined();
    expect(r.rows[0]!.label).toBe("Agent 1");
  });
});

describe("team trends", () => {
  const weekly = (counts: number[], start = "2026-08-03"): AgentMetricFacts => ({
    agents: [], commissions: [], enquiries: [],
    sales: counts.flatMap((n, w) => Array.from({ length: n }, () => ({ agentId: "a", date: new Date(Date.parse(`${start}T00:00:00Z`) + w * 7 * 86_400_000).toISOString().slice(0, 10), priceCents: 100_000_000 })))
  });

  it("buckets sales, volume and average price and compares with the previous period", () => {
    const t = buildTeamTrends(admin, weekly([2, 2, 2, 2, 2, 2]), { from: "2026-08-03", to: "2026-09-13", bucket: "week" }, "All agents");
    expect(t.buckets).toHaveLength(6);
    expect(t.partial).toEqual({ first: false, last: false });
    expect(t.series.map(s => s.key)).toEqual(["sales", "volume", "averagePrice", "conversion"]);
    expect(t.totals).toMatchObject({ sales: 12, volume: 1_200_000_000, averagePrice: 100_000_000 });
    expect(t.previous).toEqual({ from: "2026-06-22", to: "2026-08-02" });
    expect(t.direction.direction).toBe("steady");
    expect(t.signals).toEqual([]);
  });

  it("flags drops and growth against the trailing average, ignoring a cut-short last bucket", () => {
    const t = buildTeamTrends(admin, weekly([4, 4, 4, 4, 1, 4, 9, 0]), { from: "2026-08-03", to: "2026-09-22", bucket: "week" }, "All agents");
    expect(t.partial.last).toBe(true);
    const sales = t.signals.filter(s => s.measure === "sales");
    expect(sales.map(s => [s.kind, s.changePct])).toEqual([["growth", 177], ["drop", -75]]);
    expect(sales[1]!.text).toMatch(/^Sales fell 75% in the week of 31 Aug against the previous 4-week average\.$/);
  });

  it("calls a direction and hides money without the financial permission", () => {
    const up = buildTeamTrends(reporting, weekly([1, 2, 3, 4, 5, 6]), { from: "2026-08-03", to: "2026-09-13", bucket: "week" }, "All agents");
    expect(up.direction.direction).toBe("growing");
    expect(up.series.map(s => s.key)).toEqual(["sales", "conversion"]);
    expect(up.totals.volume).toBeUndefined();
    expect(up.totals.commission).toBeUndefined();
    expect(slope([1, 2, 3])).toBe(1);
    const thin = buildTeamTrends(admin, weekly([0, 0, 1]), { from: "2026-08-03", to: "2026-08-23", bucket: "week" }, "x");
    expect(thin.direction.direction).toBe("too little data");
  });
});

describe("analytics suite routes", () => {
  beforeEach(() => { state.staff = null; state.actor = null; });
  const get = (route: { GET: (r: Request) => Promise<Response> }, qs = "") => route.GET(new Request(`http://test/api/x?${qs}`));

  it("require staff with report.sales and validate input", async () => {
    expect((await get(forecastRoute)).status).toBe(401);
    state.staff = { id: "s", role: "support" };
    expect((await get(benchRoute)).status).toBe(403);
    state.staff = reporting;
    expect((await get(forecastRoute)).status).toBe(200);
    expect((await get(forecastRoute, "type=castle")).status).toBe(400);
    expect((await get(benchRoute, "days=45")).status).toBe(400);
    expect((await get(benchRoute, "team=nope")).status).toBe(400);
    expect((await get(benchRoute, "team=22222222-2222-4222-8222-222222222222")).status).toBe(400);
    const ok = await get(benchRoute, "team=11111111-1111-4111-8111-111111111111");
    expect(ok.status).toBe(200);
    expect((await ok.json()).teams).toHaveLength(1);
    expect((await get(trendsRoute, "bucket=year")).status).toBe(400);
    const tr = await get(trendsRoute, "team=11111111-1111-4111-8111-111111111111");
    expect((await tr.json()).trends.scope).toBe("North office");
  });

  it("serve the forecast to agents only", async () => {
    expect((await get(agentForecastRoute)).status).toBe(401);
    state.actor = { userId: "o", userType: "owner" };
    expect((await get(agentForecastRoute)).status).toBe(403);
    state.actor = { userId: "g", userType: "agent" };
    const r = await get(agentForecastRoute);
    expect(r.status).toBe(200);
    expect((await r.json()).forecast.forecast.state).toBe("unavailable");
  });
});
