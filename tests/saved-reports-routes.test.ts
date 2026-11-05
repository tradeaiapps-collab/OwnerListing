import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffActor } from "../src/domain/staff-access";
import type { ReportDefinition } from "../src/domain/saved-reports";

const ID = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const state = vi.hoisted(() => ({
  staff: null as StaffActor | null,
  row: null as Record<string, unknown> | null,
  created: [] as unknown[][], audits: [] as string[], updated: [] as unknown[][], cleared: 0, archived: 0, recorded: 0, due: 0
}));
const def = (o: Partial<ReportDefinition> = {}): ReportDefinition => ({ name: "Sales", dimension: "category", measures: ["offers", "revenueCents"], period: "last_30_days", compare: false, shared: false, ...o });
const fixed = { listingsCreated: 1, liveNow: 1, offers: 2, accepted: 1, revenueCents: 5000, enquiries: 3 };

vi.mock("../src/server/context", () => ({ getDb: () => ({}), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async (_d: unknown, e: { eventType: string }) => { state.audits.push(e.eventType); } }));
vi.mock("../src/server/admin-report-builder-db", () => ({ loadReport: async () => [{ key: "house", ...fixed }] }));
vi.mock("../src/server/saved-reports-run", async orig => ({ ...(await orig<object>()), runDueReports: async () => { state.due++; return { due: 0, sent: 0, notConfigured: 0, failed: 0, skipped: 0 }; } }));
vi.mock("../src/server/saved-reports-db", () => ({
  listReports: async () => (state.row ? [state.row] : []),
  getReport: async (_d: unknown, id: string) => (state.row && state.row["id"] === id ? state.row : null),
  createReport: async (...a: unknown[]) => { state.created.push(a); return ID; },
  updateReport: async (...a: unknown[]) => { state.updated.push(a); return true; },
  setSchedule: async () => undefined, clearSchedule: async () => { state.cleared++; },
  archiveReport: async () => { state.archived++; return true; },
  listRuns: async () => [{ id: RUN, trigger: "schedule", periodFrom: "2026-10-01", periodTo: "2026-10-31", createdAt: "2026-11-01T00:00:00.000Z" }],
  recordRun: async () => { state.recorded++; return RUN; },
  getRun: async (_d: unknown, _r: string, run: string) => (run === RUN ? { result: { name: "Stored", dimension: "category", dimensionLabel: "Property type", measures: ["offers"], range: { from: "2026-10-01", to: "2026-10-31", bucket: "month" }, rows: [], totals: { offers: 0 }, revenueIncluded: false, generatedAt: "2026-11-01T00:00:00Z" }, insights: { headline: "h", points: [] } } : null)
}));

import * as list from "../app/api/staff/saved-reports/route";
import * as one from "../app/api/staff/saved-reports/[id]/route";
import * as runRoute from "../app/api/staff/saved-reports/run/route";
import * as exportRoute from "../app/api/staff/saved-reports/export/route";
import * as runItem from "../app/api/staff/saved-reports/[id]/runs/[runId]/route";
import { POST as cron } from "../app/api/internal/reports/run/route";

process.env["APP_URL"] = "http://test";
const admin: StaffActor = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "super_admin" };
const reporting: StaffActor = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "reporting" };
const row = (o: Record<string, unknown> = {}) => ({ id: ID, ownerUserId: admin.id, definition: def(), shared: false, createdAt: "", updatedAt: "", schedule: null, lastRunAt: null, ...o });
const send = (url: string, method: string, body?: unknown) => new Request(`http://test${url}`, {
  method, headers: { origin: "http://test", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeEach(() => { Object.assign(state, { staff: admin, row: null, created: [], audits: [], updated: [], cleared: 0, archived: 0, recorded: 0, due: 0 }); });

describe("staff gate", () => {
  it("answers 401 signed out and 403 without report access", async () => {
    state.staff = null;
    expect((await list.GET(send("/api/staff/saved-reports", "GET"))).status).toBe(401);
    state.staff = { id: "x", role: "support" }; // no report.sales
    expect((await list.GET(send("/api/staff/saved-reports", "GET"))).status).toBe(403);
    expect((await runRoute.POST(send("/api/staff/saved-reports/run", "POST", { definition: def() }))).status).toBe(403);
    expect((await exportRoute.GET(send("/api/staff/saved-reports/export?format=csv", "GET"))).status).toBe(403);
  });
  it("refuses cross-origin writes", async () => {
    const req = new Request("http://test/api/staff/saved-reports", { method: "POST", headers: { origin: "http://evil.test", "content-type": "application/json" }, body: JSON.stringify({ definition: def() }) });
    expect((await list.POST(req)).status).toBe(403);
    expect(state.created).toHaveLength(0);
  });
});

describe("list and create", () => {
  it("offers platform fees only to a role with the financial permission", async () => {
    const keys = async () => ((await (await list.GET(send("/api/staff/saved-reports", "GET"))).json()).catalogue.measures as { key: string }[]).map(m => m.key);
    expect(await keys()).toContain("revenueCents");
    state.staff = reporting;
    expect(await keys()).not.toContain("revenueCents");
  });
  it("a shared report from someone else shows without platform fees for a role that lacks the permission, and is dropped if nothing is left", async () => {
    state.staff = reporting;
    state.row = row({ ownerUserId: admin.id, shared: true, definition: def({ shared: true }) });
    const body = await (await list.GET(send("/api/staff/saved-reports", "GET"))).json();
    expect(body.reports[0]).toMatchObject({ mine: false, definition: { measures: ["offers"] }, schedule: null });
    state.row = row({ ownerUserId: admin.id, shared: true, definition: def({ measures: ["revenueCents"] }) });
    expect((await (await list.GET(send("/api/staff/saved-reports", "GET"))).json()).reports).toEqual([]);
  });
  it("creates a report with a schedule and audits it", async () => {
    const res = await list.POST(send("/api/staff/saved-reports", "POST", { definition: def(), schedule: { frequency: "weekly", weekday: 2, hour: 8 } }));
    expect(res.status).toBe(201);
    expect(state.created).toHaveLength(1);
    expect(state.created[0]![3]).toMatchObject({ s: { frequency: "weekly", weekday: 2, hour: 8 } });
    expect(state.audits).toEqual(["staff.saved_report_created"]);
  });
  it("rejects a bad definition, a bad schedule, and fixed dates on a schedule", async () => {
    for (const b of [{ definition: { ...def(), dimension: "x" } }, { definition: def(), schedule: { frequency: "hourly" } },
      { definition: def({ period: "custom", from: "2026-10-01", to: "2026-10-02" }), schedule: { frequency: "daily" } }, null])
      expect((await list.POST(send("/api/staff/saved-reports", "POST", b === null ? [] : b))).status).toBe(400);
    state.staff = reporting;
    expect((await list.POST(send("/api/staff/saved-reports", "POST", { definition: def() }))).status).toBe(400); // fees without the permission
    expect(state.created).toHaveLength(0);
  });
});

describe("one report", () => {
  it("owner sees history; someone else sees a shared report but no history or schedule; strangers get 404", async () => {
    state.row = row({ schedule: { frequency: "daily", weekday: 1, dayOfMonth: 1, hour: 7, enabled: true, nextRunAt: "", lastRunAt: null, lastStatus: null } });
    const mine = await (await one.GET(send(`/api/staff/saved-reports/${ID}`, "GET"), ctx({ id: ID }))).json();
    expect(mine.runs).toHaveLength(1);
    expect(mine.report.schedule.description).toBe("Every day at 07:00 Brisbane time");
    state.staff = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "super_admin" };
    expect((await one.GET(send(`/api/staff/saved-reports/${ID}`, "GET"), ctx({ id: ID }))).status).toBe(404);
    state.row = row({ shared: true });
    const shared = await (await one.GET(send(`/api/staff/saved-reports/${ID}`, "GET"), ctx({ id: ID }))).json();
    expect(shared.runs).toEqual([]);
    expect(shared.report.schedule).toBeNull();
    expect((await one.GET(send("/api/staff/saved-reports/nope", "GET"), ctx({ id: "nope" }))).status).toBe(404);
  });
  it("only the owner can change or delete it", async () => {
    state.row = row({ shared: true });
    state.staff = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "super_admin" };
    expect((await one.PATCH(send(`/api/staff/saved-reports/${ID}`, "PATCH", { definition: def() }), ctx({ id: ID }))).status).toBe(404);
    expect(state.updated).toHaveLength(0);
  });
  it("PATCH updates, can stop the schedule, and refuses fixed dates when a schedule stays on", async () => {
    state.row = row({ schedule: { frequency: "daily", weekday: 1, dayOfMonth: 1, hour: 7, enabled: true, nextRunAt: "", lastRunAt: null, lastStatus: null } });
    const custom = def({ period: "custom", from: "2026-10-01", to: "2026-10-02" });
    expect((await one.PATCH(send(`/api/staff/saved-reports/${ID}`, "PATCH", { definition: custom }), ctx({ id: ID }))).status).toBe(400);
    expect((await one.PATCH(send(`/api/staff/saved-reports/${ID}`, "PATCH", { definition: custom, schedule: null }), ctx({ id: ID }))).status).toBe(200);
    expect(state.cleared).toBe(1);
    expect(state.audits).toEqual(["staff.saved_report_updated"]);
  });
  it("DELETE archives and audits", async () => {
    state.row = row();
    expect((await one.DELETE(send(`/api/staff/saved-reports/${ID}`, "DELETE"), ctx({ id: ID }))).status).toBe(200);
    expect(state.archived).toBe(1);
    expect(state.audits).toEqual(["staff.saved_report_deleted"]);
  });
});

describe("run", () => {
  it("runs an unsaved definition with Elena's summary and keeps nothing", async () => {
    const res = await runRoute.POST(send("/api/staff/saved-reports/run", "POST", { definition: def({ measures: ["offers", "enquiries"] }) }));
    const b = await res.json();
    expect(res.status).toBe(200);
    expect(b.result.rows[0]).toMatchObject({ label: "House", values: { offers: 2, enquiries: 3 } });
    expect(b.insights.headline).toContain("is the only property type with activity");
    expect(b.runId).toBeNull();
    expect(state.recorded).toBe(0);
  });
  it("keeps a snapshot only for the owner of a saved report who asks", async () => {
    state.row = row();
    expect((await (await runRoute.POST(send("/api/staff/saved-reports/run", "POST", { id: ID, record: true }))).json()).runId).toBe(RUN);
    expect(state.recorded).toBe(1);
    state.staff = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "super_admin" };
    state.row = row({ shared: true });
    expect((await (await runRoute.POST(send("/api/staff/saved-reports/run", "POST", { id: ID, record: true }))).json()).runId).toBeNull();
    expect(state.recorded).toBe(1);
  });
  it("runs a shared report for a role without the financial permission with fees left out", async () => {
    state.staff = reporting;
    state.row = row({ shared: true });
    const b = await (await runRoute.POST(send("/api/staff/saved-reports/run", "POST", { id: ID }))).json();
    expect(b.result.measures).toEqual(["offers"]);
    expect(b.result.revenueIncluded).toBe(false);
  });
  it("404 for an unknown id, 400 for nonsense", async () => {
    expect((await runRoute.POST(send("/api/staff/saved-reports/run", "POST", { id: ID }))).status).toBe(404);
    expect((await runRoute.POST(send("/api/staff/saved-reports/run", "POST", { definition: { nope: 1 } }))).status).toBe(400);
  });
});

describe("export", () => {
  const url = (q: string) => send(`/api/staff/saved-reports/export?${q}`, "GET");
  const adhoc = "name=Sales&dimension=category&measures=offers,enquiries&period=last_30_days&compare=1";
  it("returns csv, xlsx and pdf with the right type and file name, and logs each", async () => {
    const want: Record<string, [string, string]> = { csv: ["text/csv; charset=utf-8", "Property type,"], xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK"], pdf: ["application/pdf", "%PDF-"] };
    for (const f of ["csv", "xlsx", "pdf"]) {
      const res = await exportRoute.GET(url(`${adhoc}&format=${f}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(want[f]![0]);
      expect(res.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="sales-\\d{4}-\\d\\d-\\d\\d-to-\\d{4}-\\d\\d-\\d\\d\\.${f}"$`));
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await res.arrayBuffer()).toString("latin1").startsWith(want[f]![1])).toBe(true);
    }
    expect(state.audits).toEqual(Array(3).fill("staff.saved_report_exported"));
  });
  it("refuses an unknown format, a bad definition, and fees without the permission", async () => {
    expect((await exportRoute.GET(url(`${adhoc}&format=docx`))).status).toBe(400);
    expect((await exportRoute.GET(url("format=csv&dimension=zzz&measures=offers&period=last_7_days"))).status).toBe(400);
    state.staff = reporting;
    expect((await exportRoute.GET(url("format=csv&dimension=category&measures=revenueCents&period=last_7_days"))).status).toBe(400);
  });
  it("exports a saved report, and a stored snapshot only for its owner", async () => {
    state.row = row();
    expect((await exportRoute.GET(url(`id=${ID}&format=csv`))).status).toBe(200);
    const snap = await exportRoute.GET(url(`id=${ID}&run=${RUN}&format=csv`));
    expect(snap.status).toBe(200);
    expect(await snap.text()).toContain("Property type");
    state.staff = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "super_admin" };
    state.row = row({ shared: true });
    expect((await exportRoute.GET(url(`id=${ID}&format=csv`))).status).toBe(200);
    expect((await exportRoute.GET(url(`id=${ID}&run=${RUN}&format=csv`))).status).toBe(404);
  });
  it("stored runs are readable by the owner only", async () => {
    state.row = row();
    expect((await runItem.GET(send(`/api/x`, "GET"), ctx({ id: ID, runId: RUN }))).status).toBe(200);
    expect((await runItem.GET(send(`/api/x`, "GET"), ctx({ id: ID, runId: ID }))).status).toBe(404);
    state.staff = { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "super_admin" };
    expect((await runItem.GET(send(`/api/x`, "GET"), ctx({ id: ID, runId: RUN }))).status).toBe(404);
  });
});

describe("scheduled reports cron route", () => {
  const SECRET = "s".repeat(40);
  const call = (secret?: string) => cron(new Request("http://test/api/internal/reports/run", { method: "POST", headers: secret === undefined ? {} : { "x-cron-secret": secret } }));
  it("fails closed without a secret, rejects a wrong one, and runs with the right one", async () => {
    expect((await call("anything")).status).toBe(503);
    process.env["REPORTS_CRON_SECRET"] = "short";
    expect((await call("short")).status).toBe(503);
    process.env["REPORTS_CRON_SECRET"] = SECRET;
    expect((await call()).status).toBe(401);
    expect((await call(SECRET + "x")).status).toBe(401);
    expect(state.due).toBe(0);
    const ok = await call(SECRET);
    expect(ok.status).toBe(200);
    expect((await ok.json()).counts).toMatchObject({ due: 0 });
    expect(state.due).toBe(1);
    delete process.env["REPORTS_CRON_SECRET"];
  });
  it("hourly workflow calls the route with the secret header and can be run by hand", () => {
    const wf = readFileSync(path.join(__dirname, "..", ".github", "workflows", "scheduled-reports.yml"), "utf8");
    expect(wf).toContain('cron: "5 * * * *"');
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain('-H "x-cron-secret: $CRON_SECRET" "$APP_URL/api/internal/reports/run"');
    expect(wf).toContain("--fail-with-body");
  });
});
