import { describe, expect, it } from "vitest";
import { analyzePaymentPatterns, buildFinanceReport, lastMonths, trendCsv, type FinanceRaw } from "../src/domain/finance-report";

const NOW = "2026-11-10T00:00:00.000Z";
const t = (ex: number, n: number) => ({ exGstCents: ex, gstCents: ex / 10, totalCents: ex * 1.1, count: n });
const raw = (o: Partial<FinanceRaw> = {}): FinanceRaw => ({
  days: 30, current: t(100_000, 10), previous: t(50_000, 5),
  monthly: [{ month: "2026-10", ...t(80_000, 8) }, { month: "2026-11", ...t(20_000, 2) }],
  byKind: [], byMethod: [], attempts: { succeeded: 19, failed: 1, previousSucceeded: 19, previousFailed: 1 },
  outstanding: { count: 0, totalCents: 0 }, overdue: { count: 0, totalCents: 0, oldestDays: 0 },
  subscriptions: [], churned: 0, newSubscriptions: 0, openDisputes: 0,
  repeatListers: { owners: 0, avgSpentExGstCents: 0 }, monthlyPrices: { owner_plus: 19_900, agent_pro: 29_900, agent_team: 59_900 }, ...o
});

describe("finance report", () => {
  it("compares with the previous period and rounds percentages", () => {
    const r = buildFinanceReport(raw(), NOW);
    expect(r.revenue).toEqual({ current: 100_000, previous: 50_000, percent: 100 });
    expect(r.transactions.percent).toBe(100);
    expect(r.failureRatePercent).toEqual({ current: 5, previous: 5, percent: 0 });
  });
  it("gives no percentage when there is no earlier figure and handles an empty platform", () => {
    const empty = buildFinanceReport(raw({ current: t(0, 0), previous: t(0, 0), monthly: [], attempts: { succeeded: 0, failed: 0, previousFailed: 0, previousSucceeded: 0 } }), NOW);
    expect(empty.revenue.percent).toBeNull();
    expect(empty.averageInvoice.current).toBe(0);
    expect(empty.failureRatePercent.current).toBe(0);
    expect(empty.trend).toHaveLength(12);
    expect(empty.trend.every(m => m.revenueCents === 0)).toBe(true);
  });
  it("zero-fills a 12 month trend ending this month", () => {
    expect(lastMonths(NOW, 12)[0]).toBe("2025-12");
    expect(lastMonths(NOW, 12).at(-1)).toBe("2026-11");
    const r = buildFinanceReport(raw(), NOW);
    expect(r.trend.find(m => m.month === "2026-10")).toMatchObject({ revenueCents: 80_000, count: 8 });
    expect(r.trend.find(m => m.month === "2026-09")).toMatchObject({ revenueCents: 0, count: 0 });
  });
  it("normalises yearly plans to monthly revenue and counts only live subscriptions", () => {
    const r = buildFinanceReport(raw({ subscriptions: [
      { planId: "agent_pro", interval: "monthly", status: "active", priceCents: 30_000, count: 2 },
      { planId: "agent_pro", interval: "yearly", status: "past_due", priceCents: 300_000, count: 1 },
      { planId: "owner_plus", interval: "monthly", status: "pending", priceCents: 20_000, count: 5 }
    ] }), NOW);
    expect(r.mrrCents).toBe(60_000 + 25_000);
    expect(r.arrCents).toBe(r.mrrCents * 12);
    expect(r.activeSubscribers).toBe(3);
    expect(r.bySubscriptionPlan).toEqual([{ planId: "agent_pro", name: "Agent Pro", subscribers: 3, mrrCents: 85_000 }]);
  });
  it("writes a CSV that is safe to open in a spreadsheet", () => {
    const csv = trendCsv(buildFinanceReport(raw(), NOW));
    expect(csv.split("\n")[0]).toBe("month,revenue_ex_gst_cents,paid_invoices");
    expect(csv).toContain("2026-10,80000,8");
    expect(csv.endsWith("\n")).toBe(true);
  });
});

describe("Elena's payment insights", () => {
  const ins = (o: Partial<FinanceRaw> = {}) => { const r = buildFinanceReport(raw(o), NOW); return analyzePaymentPatterns(r, r === null ? {} : raw(o).monthlyPrices); };
  it("say nothing needs attention when things are steady", () => {
    expect(ins().map(i => i.id)).toEqual(["steady"]);
  });
  it("flag a rising failure rate with a bank-transfer workaround", () => {
    const i = ins({ attempts: { succeeded: 8, failed: 4, previousSucceeded: 10, previousFailed: 0 } }).find(x => x.id === "failure-rate");
    expect(i?.severity).toBe("attention");
    expect(i?.title).toMatch(/33\.3%/);
    expect(i?.action).toMatch(/bank transfer/);
  });
  it("flag overdue money and open payment issues", () => {
    const ids = ins({ overdue: { count: 2, totalCents: 22_000, oldestDays: 12 }, openDisputes: 1 }).map(i => i.id);
    expect(ids).toContain("overdue");
    expect(ids).toContain("disputes");
  });
  it("suggest Owner Plus only when it is cheaper than what repeat listers already spend", () => {
    const up = ins({ repeatListers: { owners: 4, avgSpentExGstCents: 40_000 } }).find(i => i.severity === "opportunity");
    expect(up?.id).toBe("upsell-owner-plus");
    expect(up?.detail).toMatch(/\$199\.00 a month/);
    const noUp = ins({ repeatListers: { owners: 4, avgSpentExGstCents: 10_000 } });
    expect(noUp.some(i => i.severity === "opportunity")).toBe(false);
    expect(noUp.some(i => i.id === "repeat-listers")).toBe(true);
  });
  it("say an unpriced plan cannot be offered, and never invent a price", () => {
    const r = buildFinanceReport(raw({ repeatListers: { owners: 2, avgSpentExGstCents: 40_000 } }), NOW);
    const out = analyzePaymentPatterns(r, {});
    expect(out.find(i => i.id === "repeat-listers")?.detail).toMatch(/no price yet/);
    expect(out.find(i => i.id === "unpriced")?.detail).toMatch(/Owner Plus, Agent Pro, Agent Team/);
    expect(out.some(i => i.severity === "opportunity")).toBe(false);
  });
  it("flag churn and a big revenue drop", () => {
    const ids = ins({ churned: 3, newSubscriptions: 1, current: t(30_000, 3), previous: t(50_000, 5) }).map(i => i.id);
    expect(ids).toContain("churn");
    expect(ids).toContain("revenue-drop");
  });
});
