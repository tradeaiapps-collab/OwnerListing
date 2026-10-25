import { beforeEach, describe, expect, it, vi } from "vitest";
import { bucketKeys, bucketLabel, bucketStart, buildAnalytics, parseRange, seriesFor, type MetricRow, type Range } from "../src/domain/admin-analytics";
import { buildReport, groupLabel, maskName, parseReportQuery, reportCsv, type RawReportRow, type ReportQuery } from "../src/domain/admin-report-builder";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, loads: 0, audits: [] as string[] }));
vi.mock("../src/server/context", () => ({ getDb: () => ({ query: async () => ({ rows: [] }) }), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_db: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/admin-analytics-db", () => ({ loadAnalytics: async () => { state.loads++; return []; } }));
vi.mock("../src/server/admin-report-builder-db", () => ({
  loadReport: async () => { state.loads++; return [{ key: "house", listingsCreated: 2, liveNow: 1, offers: 4, accepted: 1, revenueCents: 2200 }]; }
}));

import * as analyticsRoute from "../app/api/staff/analytics/route";
import * as reportRoute from "../app/api/staff/report-builder/route";

const P = (o: Record<string, string>) => new URLSearchParams(o);
const TODAY = "2026-10-25";
const admin: StaffActor = { id: "a", role: "super_admin" };
const reporting: StaffActor = { id: "r", role: "reporting" };
const accountant: StaffActor = { id: "c", role: "accountant" };

describe("analytics period", () => {
  it("defaults to the last 90 days by week", () => {
    expect(parseRange(P({}), TODAY)).toEqual({ ok: true, range: { from: "2026-07-28", to: TODAY, bucket: "week" } });
  });
  it("refuses bad, reversed, future and over-long periods", () => {
    expect(parseRange(P({ bucket: "year" }), TODAY).ok).toBe(false);
    expect(parseRange(P({ from: "2026-02-30" }), TODAY).ok).toBe(false);
    expect(parseRange(P({ from: "2026-10-10", to: "2026-10-01" }), TODAY).ok).toBe(false);
    expect(parseRange(P({ to: "2026-10-26" }), TODAY).ok).toBe(false);
    expect(parseRange(P({ from: "2026-01-01", bucket: "day" }), TODAY).ok).toBe(false);
    expect(parseRange(P({ from: "2024-01-01", bucket: "month" }), TODAY).ok).toBe(true);
  });
  it("buckets start on the day, the Monday or the first of the month", () => {
    expect(bucketStart("2026-10-25", "week")).toBe("2026-10-19"); // a Sunday belongs to the week from Monday 19th
    expect(bucketStart("2026-10-19", "week")).toBe("2026-10-19");
    expect(bucketStart("2026-10-25", "month")).toBe("2026-10-01");
    expect(bucketKeys({ from: "2026-11-28", to: "2027-02-02", bucket: "month" })).toEqual(["2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(bucketKeys({ from: "2026-10-30", to: "2026-11-02", bucket: "day" })).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(bucketLabel("2026-10-05", "week")).toBe("5 Oct");
    expect(bucketLabel("2026-10-01", "month")).toBe("Oct 26");
  });
  it("fills missing buckets with zero and ignores stray rows", () => {
    const rows: MetricRow[] = [
      { metric: "offers_submitted", bucket: "2026-10-12", value: 3 }, { metric: "offers_submitted", bucket: "2020-01-01", value: 9 },
      { metric: "offers_accepted", bucket: "2026-10-12", value: 1 }, { metric: "offers_submitted", bucket: "2026-10-19", value: Number.NaN }
    ];
    expect(seriesFor(rows, "offers_submitted", ["2026-10-05", "2026-10-12", "2026-10-19"])).toEqual([0, 3, 0]);
  });
});

describe("analytics output", () => {
  const range: Range = { from: "2026-10-05", to: "2026-10-25", bucket: "week" };
  const rows: MetricRow[] = [
    { metric: "offers_submitted", bucket: "2026-10-12", value: 4 }, { metric: "offers_accepted", bucket: "2026-10-12", value: 1 },
    { metric: "revenue_cents", bucket: "2026-10-19", value: 19_900 }, { metric: "signups_buyer", bucket: "2026-10-05", value: 2 }
  ];
  it("computes acceptance per bucket and over the period", () => {
    const a = buildAnalytics(reporting, range, rows);
    expect(a.buckets).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"]);
    expect(a.acceptance[0]).toMatchObject({ values: [0, 25, 0], total: 25 });
    expect(a.users.map(u => u.key)).toEqual(["owner", "agent", "buyer"]);
  });
  it("includes revenue only with the financial permission", () => {
    expect(buildAnalytics(reporting, range, rows).revenue).toBeUndefined();
    expect(buildAnalytics(accountant, range, rows).revenue?.[0]).toMatchObject({ values: [0, 0, 19_900], total: 19_900 });
  });
  it("shows other account types only when there are some", () => {
    expect(buildAnalytics(admin, range, [...rows, { metric: "signups_other", bucket: "2026-10-19", value: 1 }]).users.map(u => u.key)).toContain("other");
  });
});

describe("report builder", () => {
  const q: ReportQuery = { range: { from: "2026-10-01", to: "2026-10-25", bucket: "month" }, dimension: "agent" };
  const agent: RawReportRow = { key: "11111111-2222-4333-8444-555555555555", agentName: "Jane Citizen", listingsCreated: 3, liveNow: 2, offers: 4, accepted: 1, revenueCents: 1100 };
  it("parses the grouping and refuses unknown ones", () => {
    expect(parseReportQuery(P({ dimension: "region", from: "2025-01-01" }), TODAY)).toMatchObject({ ok: true, query: { dimension: "region" } });
    expect(parseReportQuery(P({ dimension: "owner_email" }), TODAY).ok).toBe(false);
  });
  it("masks agent names by personal-data permission", () => {
    expect(maskName("Jane  Citizen")).toBe("Jane C.");
    expect(maskName("Cher")).toBe("C.");
    expect(groupLabel(admin, "agent", agent)).toBe("Jane Citizen");
    expect(groupLabel(accountant, "agent", agent)).toBe("Jane C.");
    expect(groupLabel(reporting, "agent", agent)).toBe("Agent 11111111");
    expect(groupLabel(reporting, "agent", { ...agent, key: "none" })).toBe("No agent (owner listed)");
    expect(groupLabel(reporting, "region", { ...agent, key: "QLD" })).toBe("Queensland");
    expect(groupLabel(reporting, "suburb", { ...agent, key: "" })).toBe("Not given");
  });
  it("totals rows, sorts by listings, and leaves revenue out without the financial permission", () => {
    const rows = [agent, { ...agent, key: "none", agentName: null, listingsCreated: 5, offers: 0, accepted: 0 }];
    const r = buildReport(reporting, q, rows);
    expect(r.rows.map(x => x.key)).toEqual(["none", agent.key]);
    expect(r.totals).toEqual({ listingsCreated: 8, liveNow: 4, offers: 4, accepted: 1, acceptance: 25 });
    expect(r.rows[0]).not.toHaveProperty("revenueCents");
    expect(reportCsv(r)).not.toContain("Platform fees");
    const money = buildReport(accountant, q, rows);
    expect(money.totals.revenueCents).toBe(2200);
    expect(reportCsv(money).split("\r\n")[3]).toBe("Total,8,4,4,1,25,22.00");
  });
  it("neutralises spreadsheet formulas in group names", () => {
    expect(reportCsv(buildReport(admin, { ...q, dimension: "suburb" }, [{ ...agent, key: "=HYPERLINK(1)" }]))).toContain("'=HYPERLINK(1)");
  });
});

describe("analytics and report builder routes", () => {
  beforeEach(() => { state.staff = null; state.loads = 0; state.audits = []; });
  const get = (route: { GET: (r: Request) => Promise<Response> }, qs = "") => route.GET(new Request(`http://test/api/staff/x?${qs}`));
  it("need a staff session with the sales report permission", async () => {
    expect((await get(analyticsRoute)).status).toBe(401);
    state.staff = { id: "d", role: "designer" };
    expect((await get(analyticsRoute)).status).toBe(403);
    expect((await get(reportRoute)).status).toBe(403);
    expect(state.loads).toBe(0);
  });
  it("reject a bad period before touching the database", async () => {
    state.staff = reporting;
    const r = await get(analyticsRoute, "from=2026-10-10&to=2026-10-01");
    expect(r.status).toBe(400);
    expect((await get(reportRoute, "dimension=nope")).status).toBe(400);
    expect(state.loads).toBe(0);
  });
  it("return analytics and log report views and exports", async () => {
    state.staff = accountant;
    const a = await get(analyticsRoute, "bucket=month&from=2026-01-01");
    expect(a.status).toBe(200);
    expect((await a.json()).analytics.revenue).toBeDefined();
    const csv = await get(reportRoute, "dimension=category&format=csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("House,2,1,4,1,25,22.00");
    expect(state.audits).toEqual(["staff.report_builder_exported"]);
  });
});
