import { reasonOk, REASON_ERROR } from "./staff-admin";

/**
 * Agent commission tracking (pure functions). The platform is a record keeper: it holds no money and pays nobody. A deal records what
 * an agent is owed on a sale (percentage, fixed or tiered terms); payouts are the dates it is due and whether staff have confirmed it
 * was paid outside the platform. Money is whole cents; dates are "YYYY-MM-DD" and months "YYYY-MM" (UTC).
 */
export type CommissionKind = "percentage" | "fixed" | "tiered";
export type DealStatus = "expected" | "earned" | "cancelled";
export type PayoutStatus = "scheduled" | "paid" | "cancelled";

/** One marginal band: the part of the price up to `upToCents` (null = no upper limit, last band only) earns `bps`. */
export interface Tier { upToCents: number | null; bps: number }
export type CommissionTerms =
  | { kind: "percentage"; bps: number }
  | { kind: "fixed"; fixedCents: number }
  | { kind: "tiered"; tiers: Tier[] };

export interface CommissionDeal {
  id: string; agentUserId: string; agentName: string; listingId: string | null; title: string; salePriceCents: number;
  terms: CommissionTerms; calculatedCents: number; overrideCents: number | null; overrideReason: string | null; overrideAt: string | null;
  status: DealStatus; dealDate: string; settlementDate: string | null; closedReason: string | null; createdAt: string;
}
export interface CommissionPayout {
  id: string; dealId: string; agentUserId: string; dueDate: string; amountCents: number; status: PayoutStatus;
  paidAt: string | null; paymentReference: string | null;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const MAX_PRICE_CENTS = 100_000_000_000;
export const MAX_TIERS = 10;
export const MAX_PAYOUTS = 24;
export const DEAL_DISCLAIMER =
  "A record of commission owed, not a payment. The platform holds no money; the agent is paid outside the platform and staff confirm it here.";
export const ESTIMATE_DISCLAIMER =
  "Estimates only, based on your deals so far. They are not a promise of income and not financial advice.";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const wholeCents = (v: unknown, max = MAX_PRICE_CENTS): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v: unknown): v is string => {
  if (typeof v !== "string" || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const addDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
export const monthOf = (date: string) => date.slice(0, 7);
const addMonths = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};

// ---- Terms and calculation ----
export function parseTerms(raw: unknown): Result<CommissionTerms> {
  if (!isObj(raw)) return bad("Commission terms are required.");
  if (raw["kind"] === "percentage") {
    const bps = raw["bps"];
    if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) return bad("The percentage must be between 0% and 100%.");
    return { ok: true, value: { kind: "percentage", bps } };
  }
  if (raw["kind"] === "fixed") {
    if (!wholeCents(raw["fixedCents"])) return bad("The fixed amount must be a whole number of cents, zero or more.");
    return { ok: true, value: { kind: "fixed", fixedCents: raw["fixedCents"] } };
  }
  if (raw["kind"] === "tiered") {
    const t = raw["tiers"];
    if (!Array.isArray(t) || t.length < 1 || t.length > MAX_TIERS) return bad(`Tiered terms need 1 to ${MAX_TIERS} bands.`);
    const tiers: Tier[] = [];
    let prev = 0;
    for (const [i, row] of t.entries()) {
      if (!isObj(row)) return bad("Each band needs an upper limit and a rate.");
      const bps = row["bps"], up = row["upToCents"];
      if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) return bad("Each band rate must be between 0% and 100%.");
      const last = i === t.length - 1;
      if (last) {
        if (up !== null && up !== undefined) return bad("The last band must have no upper limit.");
        tiers.push({ upToCents: null, bps });
      } else {
        if (!wholeCents(up) || up <= prev) return bad("Band limits must increase.");
        prev = up;
        tiers.push({ upToCents: up, bps });
      }
    }
    return { ok: true, value: { kind: "tiered", tiers } };
  }
  return bad("Commission type must be percentage, fixed or tiered.");
}

/** Round half up of n/d for non-negative bigints. */
const divRound = (n: bigint, d: bigint) => (n + d / 2n) / d;

/** Commission in cents for a sale price. Tiered bands are marginal: each band's rate applies only to the part of the price inside it. */
export function computeCommission(terms: CommissionTerms, priceCents: number): number {
  if (terms.kind === "fixed") return terms.fixedCents;
  if (terms.kind === "percentage") return Number(divRound(BigInt(priceCents) * BigInt(terms.bps), 10_000n));
  let sum = 0n, floor = 0;
  for (const t of terms.tiers) {
    const top = t.upToCents ?? priceCents;
    const part = Math.max(0, Math.min(priceCents, top) - floor);
    sum += BigInt(part) * BigInt(t.bps);
    floor = top;
    if (priceCents <= top) break;
  }
  return Number(divRound(sum, 10_000n));
}

export const effectiveCents = (d: Pick<CommissionDeal, "calculatedCents" | "overrideCents">) => d.overrideCents ?? d.calculatedCents;
const scheduledTotal = (ps: readonly CommissionPayout[]) => ps.filter(p => p.status !== "cancelled").reduce((s, p) => s + p.amountCents, 0);
/** What is still owed but has no payout date. */
export const unscheduledCents = (d: CommissionDeal, ps: readonly CommissionPayout[]) =>
  Math.max(0, effectiveCents(d) - scheduledTotal(ps.filter(p => p.dealId === d.id)));

// ---- Input validation ----
export interface NewDealInput {
  agentUserId: string; listingId: string | null; title: string; salePriceCents: number; terms: CommissionTerms;
  dealDate: string; settlementDate: string | null; schedule: PayoutInput[];
}
export interface PayoutInput { dueDate: string; amountCents: number }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAIN = /^[^\u0000-\u001f\u007f<>]*$/;

/** `totalCents` null skips the sum check (the database layer checks against what is still owed). */
export function parseSchedule(raw: unknown, totalCents: number | null): Result<PayoutInput[]> {
  if (!Array.isArray(raw) || raw.length > MAX_PAYOUTS) return bad(`A payout schedule has at most ${MAX_PAYOUTS} payments.`);
  const out: PayoutInput[] = [];
  for (const r of raw) {
    if (!isObj(r) || !isDate(r["dueDate"]) || typeof r["amountCents"] !== "number" || !Number.isSafeInteger(r["amountCents"]) || r["amountCents"] <= 0)
      return bad("Each payment needs a due date and an amount above zero.");
    out.push({ dueDate: r["dueDate"], amountCents: r["amountCents"] });
  }
  const sum = out.reduce((s, p) => s + p.amountCents, 0);
  if (totalCents !== null && out.length > 0 && sum !== totalCents) return bad("The payments must add up to the commission still to be scheduled.");
  return { ok: true, value: out.sort((a, b) => a.dueDate.localeCompare(b.dueDate)) };
}

export function parseNewDeal(raw: unknown): Result<NewDealInput> {
  if (!isObj(raw)) return bad("Send the deal details.");
  const agentUserId = raw["agentUserId"];
  if (typeof agentUserId !== "string" || !UUID_RE.test(agentUserId)) return bad("Choose an agent.");
  const listingId = raw["listingId"] ?? null;
  if (listingId !== null && (typeof listingId !== "string" || !UUID_RE.test(listingId))) return bad("The listing id is not valid.");
  const title = typeof raw["title"] === "string" ? raw["title"].trim() : "";
  if (title.length < 1 || title.length > 200 || !PLAIN.test(title)) return bad("A title of 1 to 200 plain characters is required.");
  const price = raw["salePriceCents"];
  if (!wholeCents(price) || price <= 0) return bad("The sale price must be above zero.");
  const terms = parseTerms(raw["terms"]);
  if (!terms.ok) return terms;
  if (!isDate(raw["dealDate"])) return bad("The deal date must be a real date (YYYY-MM-DD).");
  const settlement = raw["settlementDate"] ?? null;
  if (settlement !== null && !isDate(settlement)) return bad("The settlement date must be a real date (YYYY-MM-DD).");
  if (settlement !== null && settlement < raw["dealDate"]) return bad("Settlement cannot be before the deal date.");
  const total = computeCommission(terms.value, price);
  const schedule = parseSchedule(raw["schedule"] ?? [], total);
  if (!schedule.ok) return schedule;
  return { ok: true, value: { agentUserId, listingId, title, salePriceCents: price, terms: terms.value, dealDate: raw["dealDate"], settlementDate: settlement, schedule: schedule.value } };
}

export function parseOverride(raw: unknown): Result<{ overrideCents: number | null; reason: string }> {
  if (!isObj(raw)) return bad("Send the override.");
  if (!reasonOk(raw["reason"])) return bad(REASON_ERROR);
  const reason = raw["reason"].trim();
  if (raw["overrideCents"] === null) return { ok: true, value: { overrideCents: null, reason } };
  if (!wholeCents(raw["overrideCents"])) return bad("The override must be a whole number of cents, zero or more.");
  return { ok: true, value: { overrideCents: raw["overrideCents"], reason } };
}

/** `count` equal payments `everyDays` apart from `firstDue`; any odd cents go on the last one. */
export function evenSchedule(totalCents: number, firstDue: string, count: number, everyDays: number): PayoutInput[] {
  const n = Math.max(1, Math.min(MAX_PAYOUTS, Math.floor(count)));
  const base = Math.floor(totalCents / n);
  return Array.from({ length: n }, (_, i) => ({ dueDate: addDays(firstDue, i * everyDays), amountCents: i === n - 1 ? totalCents - base * (n - 1) : base })).filter(p => p.amountCents > 0);
}

// ---- Summaries ----
export interface AgentTotals {
  earnedCents: number; expectedCents: number; paidCents: number; dueCents: number; overdueCents: number; unscheduledCents: number;
  openDeals: number; earnedDeals: number; cancelledDeals: number; averageRateBps: number | null; nextPayout: { dueDate: string; amountCents: number } | null;
}

export function agentTotals(deals: readonly CommissionDeal[], payouts: readonly CommissionPayout[], today: string): AgentTotals {
  const live = deals.filter(d => d.status !== "cancelled");
  const open = payouts.filter(p => p.status === "scheduled");
  const upcoming = open.filter(p => p.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const earned = deals.filter(d => d.status === "earned");
  const price = earned.reduce((s, d) => s + d.salePriceCents, 0);
  return {
    earnedCents: earned.reduce((s, d) => s + effectiveCents(d), 0),
    expectedCents: deals.filter(d => d.status === "expected").reduce((s, d) => s + effectiveCents(d), 0),
    paidCents: payouts.filter(p => p.status === "paid").reduce((s, p) => s + p.amountCents, 0),
    dueCents: open.reduce((s, p) => s + p.amountCents, 0),
    overdueCents: open.filter(p => p.dueDate < today).reduce((s, p) => s + p.amountCents, 0),
    unscheduledCents: live.reduce((s, d) => s + unscheduledCents(d, payouts), 0),
    openDeals: deals.filter(d => d.status === "expected").length,
    earnedDeals: earned.length,
    cancelledDeals: deals.filter(d => d.status === "cancelled").length,
    averageRateBps: price > 0 ? Number(divRound(BigInt(earned.reduce((s, d) => s + effectiveCents(d), 0)) * 10_000n, BigInt(price))) : null,
    nextPayout: upcoming ? { dueDate: upcoming.dueDate, amountCents: upcoming.amountCents } : null
  };
}

export interface StatementLine { date: string; dealTitle: string; kind: "paid" | "due"; amountCents: number; reference: string | null }
export interface Statement { month: string; lines: StatementLine[]; paidCents: number; dueCents: number }

/** A month's statement: payouts paid in the month, and payouts still scheduled with a due date in it. */
export function buildStatement(deals: readonly CommissionDeal[], payouts: readonly CommissionPayout[], month: string): Statement {
  const title = new Map(deals.map(d => [d.id, d.title]));
  const lines: StatementLine[] = [];
  for (const p of payouts) {
    if (p.status === "paid" && p.paidAt && monthOf(p.paidAt) === month)
      lines.push({ date: p.paidAt.slice(0, 10), dealTitle: title.get(p.dealId) ?? "Deal", kind: "paid", amountCents: p.amountCents, reference: p.paymentReference });
    else if (p.status === "scheduled" && monthOf(p.dueDate) === month)
      lines.push({ date: p.dueDate, dealTitle: title.get(p.dealId) ?? "Deal", kind: "due", amountCents: p.amountCents, reference: null });
  }
  lines.sort((a, b) => a.date.localeCompare(b.date));
  return {
    month, lines,
    paidCents: lines.filter(l => l.kind === "paid").reduce((s, l) => s + l.amountCents, 0),
    dueCents: lines.filter(l => l.kind === "due").reduce((s, l) => s + l.amountCents, 0)
  };
}

const csvCell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v; // spreadsheet formula guard
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const dollars = (cents: number) => `${cents < 0 ? "-" : ""}${(Math.abs(cents) / 100).toFixed(2)}`;
export function statementCsv(s: Statement): string {
  const rows = [["Date", "Deal", "Status", "Amount (AUD)", "Reference"], ...s.lines.map(l => [l.date, l.dealTitle, l.kind === "paid" ? "Paid" : "Due", dollars(l.amountCents), l.reference ?? ""])];
  return rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export interface AdminAnalytics {
  byStatus: { status: DealStatus; deals: number; commissionCents: number }[];
  byKind: { kind: CommissionKind; deals: number; commissionCents: number }[];
  byMonth: { month: string; earnedCents: number; paidCents: number }[];
  topAgents: { agentUserId: string; agentName: string; deals: number; earnedCents: number }[];
  overrides: number; overdueCents: number; overduePayouts: number; unscheduledCents: number; paidCents: number; dueCents: number;
}

/** Platform-wide figures for staff. `byMonth` covers the last 12 months ending with the month of `today`. */
export function adminAnalytics(deals: readonly CommissionDeal[], payouts: readonly CommissionPayout[], today: string): AdminAnalytics {
  const statuses: DealStatus[] = ["expected", "earned", "cancelled"], kinds: CommissionKind[] = ["percentage", "fixed", "tiered"];
  const cur = monthOf(today);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(cur, i - 11));
  const earned = deals.filter(d => d.status === "earned");
  const agents = new Map<string, { agentName: string; deals: number; earnedCents: number }>();
  for (const d of earned) {
    const a = agents.get(d.agentUserId) ?? { agentName: d.agentName, deals: 0, earnedCents: 0 };
    a.deals += 1; a.earnedCents += effectiveCents(d);
    agents.set(d.agentUserId, a);
  }
  const open = payouts.filter(p => p.status === "scheduled");
  return {
    byStatus: statuses.map(status => ({ status, deals: deals.filter(d => d.status === status).length, commissionCents: deals.filter(d => d.status === status).reduce((s, d) => s + effectiveCents(d), 0) })),
    byKind: kinds.map(kind => ({ kind, deals: deals.filter(d => d.terms.kind === kind).length, commissionCents: deals.filter(d => d.terms.kind === kind).reduce((s, d) => s + effectiveCents(d), 0) })),
    byMonth: months.map(month => ({
      month,
      earnedCents: earned.filter(d => monthOf(d.settlementDate ?? d.dealDate) === month).reduce((s, d) => s + effectiveCents(d), 0),
      paidCents: payouts.filter(p => p.status === "paid" && p.paidAt && monthOf(p.paidAt) === month).reduce((s, p) => s + p.amountCents, 0)
    })),
    topAgents: [...agents.entries()].map(([agentUserId, a]) => ({ agentUserId, ...a })).sort((a, b) => b.earnedCents - a.earnedCents).slice(0, 10),
    overrides: deals.filter(d => d.overrideCents !== null).length,
    overdueCents: open.filter(p => p.dueDate < today).reduce((s, p) => s + p.amountCents, 0),
    overduePayouts: open.filter(p => p.dueDate < today).length,
    unscheduledCents: deals.filter(d => d.status !== "cancelled").reduce((s, d) => s + unscheduledCents(d, payouts), 0),
    paidCents: payouts.filter(p => p.status === "paid").reduce((s, p) => s + p.amountCents, 0),
    dueCents: open.reduce((s, p) => s + p.amountCents, 0)
  };
}

// ---- Forecast (what Elena says about future earnings) ----
export interface ForecastMonth { month: string; scheduledCents: number; pipelineCents: number; totalCents: number }
export interface Forecast { months: ForecastMonth[]; closeRate: number; closeRateBasis: "history" | "default"; confidence: "low" | "medium" | "high"; method: string }
export const DEFAULT_CLOSE_RATE = 0.7;

/**
 * Next `months` months of expected income. Scheduled = payouts already dated (overdue ones count in the current month).
 * Pipeline = commission on open deals that has no payout date yet, weighted by how often this agent's closed deals were earned
 * rather than cancelled (70% until there are 3 closed deals), placed in the settlement month (deal date plus 60 days if unknown).
 */
export function forecastEarnings(deals: readonly CommissionDeal[], payouts: readonly CommissionPayout[], today: string, months = 3): Forecast {
  const cur = monthOf(today);
  const list: ForecastMonth[] = Array.from({ length: months }, (_, i) => ({ month: addMonths(cur, i), scheduledCents: 0, pipelineCents: 0, totalCents: 0 }));
  const slot = (date: string) => list.find(m => m.month === (monthOf(date) < cur ? cur : monthOf(date)));
  const live = new Set(deals.filter(d => d.status !== "cancelled").map(d => d.id));
  for (const p of payouts) if (p.status === "scheduled" && live.has(p.dealId)) { const m = slot(p.dueDate); if (m) m.scheduledCents += p.amountCents; }
  const earned = deals.filter(d => d.status === "earned").length, cancelled = deals.filter(d => d.status === "cancelled").length;
  const closed = earned + cancelled;
  const closeRate = closed >= 3 ? earned / closed : DEFAULT_CLOSE_RATE;
  for (const d of deals) {
    if (d.status !== "expected") continue;
    const m = slot(d.settlementDate ?? addDays(d.dealDate, 60));
    if (m) m.pipelineCents += Math.round(unscheduledCents(d, payouts) * closeRate);
  }
  for (const m of list) m.totalCents = m.scheduledCents + m.pipelineCents;
  return {
    months: list, closeRate, closeRateBasis: closed >= 3 ? "history" : "default",
    confidence: closed >= 10 ? "high" : closed >= 3 ? "medium" : "low",
    method: "Dated payouts count in full. Open deals without payout dates count at your close rate in their settlement month."
  };
}

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "long", year: "numeric", timeZone: "UTC" });

export interface ElenaCommissionSummary { text: string; highlights: string[]; disclaimer: string }

/**
 * Elena's plain-English summary and earnings outlook. Written from the numbers by fixed templates, so every figure is exact and
 * nothing is invented; a language model is deliberately not used for amounts. It never gives financial or tax advice.
 */
export function elenaCommissionSummary(agentFirstName: string, t: AgentTotals, f: Forecast): ElenaCommissionSummary {
  const highlights: string[] = [];
  const name = agentFirstName.trim() || "there";
  if (t.earnedDeals + t.openDeals + t.cancelledDeals === 0) {
    return { text: `Hi ${name}, you have no commission deals recorded yet. When staff record one for you, I'll summarise it here and estimate what's coming.`, highlights, disclaimer: ESTIMATE_DISCLAIMER };
  }
  highlights.push(`Earned so far: ${money(t.earnedCents)} across ${t.earnedDeals} deal${t.earnedDeals === 1 ? "" : "s"}; ${money(t.paidCents)} of it paid.`);
  if (t.openDeals > 0) highlights.push(`${t.openDeals} open deal${t.openDeals === 1 ? "" : "s"} worth ${money(t.expectedCents)} once they settle.`);
  if (t.nextPayout) highlights.push(`Next payment: ${money(t.nextPayout.amountCents)} due ${t.nextPayout.dueDate}.`);
  if (t.overdueCents > 0) highlights.push(`${money(t.overdueCents)} is past its due date. Ask staff to check it.`);
  if (t.unscheduledCents > 0) highlights.push(`${money(t.unscheduledCents)} has no payment date yet.`);
  if (t.averageRateBps !== null) highlights.push(`Your average rate on earned deals is ${(t.averageRateBps / 100).toFixed(2)}%.`);
  const best = [...f.months].sort((a, b) => b.totalCents - a.totalCents)[0];
  const total = f.months.reduce((s, m) => s + m.totalCents, 0);
  const outlook = total === 0
    ? "I can't see any income due in the next three months."
    : `I expect about ${money(total)} over the next ${f.months.length} months, most of it in ${monthName(best!.month)} (${money(best!.totalCents)}). ` +
      `That counts dated payments in full and open deals at a ${Math.round(f.closeRate * 100)}% close rate (${f.closeRateBasis === "history" ? "from your history" : "a default until you have more closed deals"}). My confidence is ${f.confidence}.`;
  highlights.push(outlook);
  return { text: `Hi ${name}. ${highlights.join(" ")}`, highlights, disclaimer: ESTIMATE_DISCLAIMER };
}
