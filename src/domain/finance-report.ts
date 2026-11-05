import { SUBSCRIPTION_PLANS, DEFAULT_PLANS, type BillingInterval } from "./plans";

/**
 * The admin financial dashboard. The database returns grouped totals (src/server/finance-db.ts); everything here is pure shaping:
 * period comparison, a zero-filled monthly trend, MRR, failure rate and overdue totals. No personal data appears anywhere in the report.
 * Amounts are cents. "Revenue" is the platform's own fees (paid invoices) and is shown excluding GST; GST is reported separately.
 * The platform holds no deposits or buyer money, so none of it appears here.
 */
export interface Totals { exGstCents: number; gstCents: number; totalCents: number; count: number }
export interface MonthRow extends Totals { month: string }
export interface GroupRow { key: string; totalCents: number; exGstCents: number; count: number }

export interface FinanceRaw {
  days: number;
  current: Totals;
  previous: Totals;
  /** Paid invoices per calendar month (UTC "YYYY-MM"), most recent 12 months. Months with no revenue may be missing. */
  monthly: MonthRow[];
  byKind: GroupRow[];
  byMethod: GroupRow[];
  /** Payment attempts the provider reported in the window. */
  attempts: { succeeded: number; failed: number; previousFailed: number; previousSucceeded: number };
  outstanding: { count: number; totalCents: number };
  overdue: { count: number; totalCents: number; oldestDays: number };
  /** Live subscriptions: price is per period, excl. GST. */
  subscriptions: { planId: string; interval: BillingInterval; status: string; priceCents: number; count: number }[];
  churned: number;
  newSubscriptions: number;
  openDisputes: number;
  /** Owners who paid for 2 or more listing fees in the last 90 days and hold no live subscription. */
  repeatListers: { owners: number; avgSpentExGstCents: number };
  /** Current admin-set monthly prices by plan id (excl. GST). */
  monthlyPrices: Record<string, number>;
}

export interface Change { current: number; previous: number; percent: number | null }
const change = (current: number, previous: number): Change => ({ current, previous, percent: previous === 0 ? null : Math.round(((current - previous) / previous) * 1000) / 10 });

export interface FinanceReport {
  days: number;
  revenue: Change; gst: Change; transactions: Change; averageInvoice: Change;
  failureRatePercent: Change;
  mrrCents: number; arrCents: number; activeSubscribers: number; churned: number; newSubscriptions: number;
  outstanding: FinanceRaw["outstanding"]; overdue: FinanceRaw["overdue"]; openDisputes: number;
  trend: { month: string; revenueCents: number; count: number }[];
  byKind: GroupRow[]; byMethod: GroupRow[];
  bySubscriptionPlan: { planId: string; name: string; subscribers: number; mrrCents: number }[];
  repeatListers: FinanceRaw["repeatListers"];
}

/** Last `n` UTC months ending with the month of `now`, oldest first. */
export function lastMonths(now: string, n: number): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

const monthlyOf = (priceCents: number, interval: BillingInterval) => (interval === "yearly" ? Math.round(priceCents / 12) : priceCents);
const PLAN_NAMES = new Map([...DEFAULT_PLANS, ...SUBSCRIPTION_PLANS].map(p => [p.id, p.name] as const));

export function buildFinanceReport(raw: FinanceRaw, now: string): FinanceReport {
  const byMonth = new Map(raw.monthly.map(m => [m.month, m] as const));
  const live = raw.subscriptions.filter(s => s.status === "active" || s.status === "past_due");
  const plans = new Map<string, { subscribers: number; mrrCents: number }>();
  for (const s of live) {
    const e = plans.get(s.planId) ?? { subscribers: 0, mrrCents: 0 };
    e.subscribers += s.count;
    e.mrrCents += monthlyOf(s.priceCents, s.interval) * s.count;
    plans.set(s.planId, e);
  }
  const mrr = [...plans.values()].reduce((a, p) => a + p.mrrCents, 0);
  const rate = (f: number, s: number) => (f + s === 0 ? 0 : Math.round((f / (f + s)) * 1000) / 10);
  const avg = (t: Totals) => (t.count === 0 ? 0 : Math.round(t.totalCents / t.count));
  return {
    days: raw.days,
    revenue: change(raw.current.exGstCents, raw.previous.exGstCents),
    gst: change(raw.current.gstCents, raw.previous.gstCents),
    transactions: change(raw.current.count, raw.previous.count),
    averageInvoice: change(avg(raw.current), avg(raw.previous)),
    failureRatePercent: change(rate(raw.attempts.failed, raw.attempts.succeeded), rate(raw.attempts.previousFailed, raw.attempts.previousSucceeded)),
    mrrCents: mrr, arrCents: mrr * 12,
    activeSubscribers: live.reduce((a, s) => a + s.count, 0),
    churned: raw.churned, newSubscriptions: raw.newSubscriptions,
    outstanding: raw.outstanding, overdue: raw.overdue, openDisputes: raw.openDisputes,
    trend: lastMonths(now, 12).map(month => ({ month, revenueCents: byMonth.get(month)?.exGstCents ?? 0, count: byMonth.get(month)?.count ?? 0 })),
    byKind: raw.byKind, byMethod: raw.byMethod,
    bySubscriptionPlan: [...plans.entries()].map(([planId, v]) => ({ planId, name: PLAN_NAMES.get(planId) ?? planId, ...v })).sort((a, b) => b.mrrCents - a.mrrCents),
    repeatListers: raw.repeatListers
  };
}

/** CSV of the monthly trend. Cells that start with a formula character get a leading apostrophe. */
export function trendCsv(r: FinanceReport): string {
  const esc = (v: string | number) => { const s = String(v); return /^[=+\-@\t\r]/.test(s) ? `'${s}` : /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return ["month,revenue_ex_gst_cents,paid_invoices", ...r.trend.map(t => [t.month, t.revenueCents, t.count].map(esc).join(","))].join("\n") + "\n";
}

export interface Insight {
  id: string;
  severity: "info" | "attention" | "opportunity";
  title: string;
  detail: string;
  /** A suggestion for staff. Elena never contacts customers or changes prices herself. */
  action: string;
}

const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);

/**
 * Elena's read of the payment patterns, for staff. Rule based and deterministic: every line is computed from the report's own
 * numbers, so staff can check it. She suggests; staff decide. Upsell ideas only compare plan prices the admin has already set.
 */
export function analyzePaymentPatterns(r: FinanceReport, monthlyPrices: Readonly<Record<string, number>>): Insight[] {
  const out: Insight[] = [];
  if (r.failureRatePercent.current >= 10 && r.failureRatePercent.current > r.failureRatePercent.previous) {
    out.push({
      id: "failure-rate", severity: "attention", title: `Payment failures are up to ${r.failureRatePercent.current}%`,
      detail: `${r.failureRatePercent.current}% of payment attempts failed in the last ${r.days} days, up from ${r.failureRatePercent.previous}% in the period before.`,
      action: "Check the provider's status and the most recent failed invoices. Offering bank transfer to affected customers is a quick workaround."
    });
  }
  if (r.overdue.count > 0) {
    out.push({
      id: "overdue", severity: "attention", title: `${r.overdue.count} overdue invoice${r.overdue.count === 1 ? "" : "s"} (${aud(r.overdue.totalCents)})`,
      detail: `The oldest is ${r.overdue.oldestDays} day${r.overdue.oldestDays === 1 ? "" : "s"} past due. Reminders go out automatically at 3 days before, on the due date, 3 days after and 10 days after.`,
      action: "Review the overdue list. Bank-transfer customers may have paid already; reconcile before chasing."
    });
  }
  if (r.openDisputes > 0) {
    out.push({
      id: "disputes", severity: "attention", title: `${r.openDisputes} open payment dispute${r.openDisputes === 1 ? "" : "s"}`,
      detail: "Customers are waiting for a written answer.", action: "Resolve or reject each one with a reason."
    });
  }
  const ownerPlus = monthlyPrices["owner_plus"];
  if (r.repeatListers.owners > 0) {
    const spent = r.repeatListers.avgSpentExGstCents;
    if (ownerPlus !== undefined && ownerPlus < spent) {
      out.push({
        id: "upsell-owner-plus", severity: "opportunity", title: `${r.repeatListers.owners} owner${r.repeatListers.owners === 1 ? "" : "s"} could save on Owner Plus`,
        detail: `They each paid for 2 or more listings in 90 days (about ${aud(spent)} excl. GST on average) and have no plan. Owner Plus is ${aud(ownerPlus)} a month excl. GST.`,
        action: "Show Owner Plus to these owners at checkout. Elena already mentions it when they ask about fees."
      });
    } else {
      out.push({
        id: "repeat-listers", severity: "info", title: `${r.repeatListers.owners} owner${r.repeatListers.owners === 1 ? "" : "s"} listed more than once recently`,
        detail: `Average spend about ${aud(spent)} excl. GST in 90 days. ${ownerPlus === undefined ? "Owner Plus has no price yet, so it cannot be offered." : "Owner Plus is not cheaper than what they paid."}`,
        action: ownerPlus === undefined ? "Set an Owner Plus price in Pricing and plans if you want to offer it." : "Consider whether Owner Plus is priced to suit repeat listers."
      });
    }
  }
  const unpriced = SUBSCRIPTION_PLANS.filter(p => monthlyPrices[p.id] === undefined).map(p => p.name);
  if (unpriced.length > 0) {
    out.push({ id: "unpriced", severity: "info", title: `${unpriced.length} subscription plan${unpriced.length === 1 ? "" : "s"} without a price`, detail: `${unpriced.join(", ")} cannot be bought until an admin sets a price.`, action: "Set prices in Pricing and plans." });
  }
  if (r.churned > r.newSubscriptions && r.churned > 0) {
    out.push({ id: "churn", severity: "attention", title: "More subscriptions ended than started", detail: `${r.churned} ended and ${r.newSubscriptions} started in the last ${r.days} days.`, action: "Look at who cancelled and why before changing prices." });
  }
  if (r.revenue.percent !== null && r.revenue.percent <= -20) {
    out.push({ id: "revenue-drop", severity: "attention", title: `Revenue is down ${Math.abs(r.revenue.percent)}%`, detail: `${aud(r.revenue.current)} excl. GST against ${aud(r.revenue.previous)} in the period before.`, action: "Compare against listings published in the same periods on the analytics page." });
  }
  if (out.length === 0) out.push({ id: "steady", severity: "info", title: "Nothing needs attention", detail: "Payments, reminders and subscriptions look steady.", action: "No action needed." });
  return out;
}
