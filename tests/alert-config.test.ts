import { describe, expect, it, vi } from "vitest";
import { ALERT_DEFS, defaultAlertSettings, parseAlertSettings, resolveAlertSettings, thresholdOk } from "../src/domain/alert-config";
import { buildInsights, type InsightFacts, type PeriodCounts } from "../src/domain/admin-elena-insights";
import type { StaffActor } from "../src/domain/staff-access";

const state = vi.hoisted(() => ({ staff: null as StaffActor | null, saved: 0, audits: 0, cfg: [] as Record<string, unknown>[] }));
vi.mock("../src/server/context", () => ({ getDb: () => ({ query: async (sql: string) => { if (/INSERT INTO alert_config/.test(sql)) state.saved++; return { rows: /FROM alert_config/.test(sql) ? state.cfg : [] }; } }), getStaff: async () => state.staff }));
vi.mock("../src/server/db", () => ({ appendAuditPg: async () => { state.audits++; } }));
import * as route from "../app/api/staff/alerts/route";

const actor = (permissions: string[]) => ({ id: "11111111-1111-4111-8111-111111111111", role: "x", permissions, email: "a@b.c" }) as unknown as StaffActor;
const admin = actor(["pii.view_full", "report.sales", "config.edit"]);
const pc = (o: Partial<PeriodCounts> = {}): PeriodCounts => ({ listings: 0, enquiries: 0, offers: 0, accepted: 0, decided: 0, ...o });
const facts = (o: Partial<InsightFacts>): InsightFacts => ({ current: pc(), previous: pc(), areas: [], agents: [], ...o });
const agent = { id: "a", name: "Jane", listings: 1, enquiries: 6, unanswered: 4, offers: 0, accepted: 0, decided: 0 };
const area = (o: object) => ({ jurisdiction: "QLD", suburb: "x", current: pc(), previous: pc(), publishedNow: 0, ...o });

describe("alert thresholds: domain", () => {
  it("defaults match the old hardcoded rules", () => {
    const d = defaultAlertSettings();
    expect([d.agent_unanswered.threshold, d.agent_acceptance_gap.threshold, d.agent_slow_reply.threshold, d.area_conversion.threshold, d.area_enquiry_drop.threshold, d.area_quiet.threshold]).toEqual([24, 20, 2, 50, 40, 3]);
    expect(Object.values(d).every(s => s.enabled)).toBe(true);
  });
  it("falls back to defaults for unknown types and out-of-range values", () => {
    const s = resolveAlertSettings([{ alertType: "agent_unanswered", threshold: 48, enabled: true }, { alertType: "area_quiet", threshold: 999, enabled: false }, { alertType: "bogus", threshold: 1, enabled: true }]);
    expect(s.agent_unanswered.threshold).toBe(48);
    expect(s.area_quiet).toEqual({ threshold: 3, enabled: false });
  });
  it("validates ranges and steps", () => {
    expect(thresholdOk("agent_unanswered", 11)).toBe(false);
    expect(thresholdOk("agent_unanswered", 72)).toBe(true);
    expect(thresholdOk("agent_slow_reply", 2.5)).toBe(true);
    expect(thresholdOk("agent_slow_reply", 2.3)).toBe(false);
    expect(parseAlertSettings({}).ok).toBe(false);
    expect(parseAlertSettings({ settings: { ...defaultAlertSettings(), area_quiet: { threshold: 0, enabled: true } } }).ok).toBe(false);
    expect(parseAlertSettings({ settings: defaultAlertSettings() }).ok).toBe(true);
    expect(ALERT_DEFS).toHaveLength(6);
  });
  it("unanswered threshold and switch change the alert", () => {
    const f = facts({ agents: [agent] });
    const c = defaultAlertSettings();
    expect(buildInsights(admin, f, c).alerts.map(a => a.message).join()).toContain("after 24 hours");
    c.agent_unanswered.threshold = 48;
    expect(buildInsights(admin, f, c).alerts.map(a => a.message).join()).toContain("after 48 hours");
    c.agent_unanswered.enabled = false;
    expect(buildInsights(admin, f, c).alerts).toHaveLength(0);
  });
  it("area rules follow their thresholds", () => {
    const f = facts({ areas: [area({ previous: pc({ enquiries: 10 }), current: pc({ enquiries: 7 }) }), area({ suburb: "q", publishedNow: 2 })] });
    expect(buildInsights(admin, f).alerts).toHaveLength(0); // 30% fall under 40%; 2 listings under 3
    const c = defaultAlertSettings();
    c.area_enquiry_drop.threshold = 30; c.area_quiet.threshold = 2;
    expect(buildInsights(admin, f, c).alerts.map(a => a.id).sort()).toEqual(["area-drop-QLD-x", "area-quiet-QLD-q"]);
  });
});

describe("/api/staff/alerts", () => {
  vi.stubEnv("APP_URL", "http://x");
  const put = (body: unknown) => route.PUT(new Request("http://x/api/staff/alerts", { method: "PUT", headers: { "content-type": "application/json", origin: "http://x" }, body: JSON.stringify(body) }));
  it("needs sign-in and config.edit to save", async () => {
    state.staff = null;
    expect((await put({ settings: defaultAlertSettings() })).status).toBe(401);
    state.staff = actor(["report.sales"]);
    expect((await put({ settings: defaultAlertSettings() })).status).toBe(403);
  });
  it("rejects out-of-range values and saves valid ones with an audit entry", async () => {
    state.staff = admin; state.saved = 0; state.audits = 0;
    const bad = { settings: { ...defaultAlertSettings(), agent_unanswered: { threshold: 5, enabled: true } } };
    expect((await put(bad)).status).toBe(400);
    expect(state.saved).toBe(0);
    expect((await put({ settings: defaultAlertSettings() })).status).toBe(200);
    expect(state.saved).toBe(6);
    expect(state.audits).toBe(1);
  });
  it("lets report.sales read but marks it read-only", async () => {
    state.staff = actor(["report.sales"]); state.cfg = [{ alert_type: "agent_unanswered", threshold: 36, enabled: false }];
    const r = await route.GET(new Request("http://x/api/staff/alerts"));
    const j = await r.json();
    expect(j.canEdit).toBe(false);
    expect(j.settings.agent_unanswered).toEqual({ threshold: 36, enabled: false });
  });
});
