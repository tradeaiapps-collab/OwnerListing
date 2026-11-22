import { depositBps, formatBps, isOpen, versusAsking } from "./offer-detail";
import type { Scenario } from "./negotiation-coach";
import { parseCounterInput, type CounterInput } from "./offer-counter";

/**
 * Side-by-side comparison of the open offers on ONE listing, for its owner or appointed agent. Pure rules, so it reads the same with the AI off.
 * Buyers are only "Offer A", "Offer B": no identity, and nothing from the negotiation mandate. One buyer's terms are never put in text meant
 * for another buyer: the questions below are about the one offer they belong to and carry no amounts.
 * Elena suggests. She never accepts, rejects or sends anything (see counterDraftFrom, which only fills in a form the owner edits).
 */

export const MAX_COMPARED = 8;

export interface PrequalLite { state: "verified" | "pending" | "expired" | "none"; label: string; approvedCents?: number; expiresAt?: string }

export interface CompareInput {
  id: string; priceCents: number; depositCents: number; settlementDays: number; conditions: readonly string[]; status: string; submittedAt: string;
  /** The owner's own counter waiting for the buyer: its reply-by time is the only expiry an offer has. */
  openCounter?: { expiresAt: string };
  prequal?: PrequalLite;
}

export type Finance = "verified" | "pending" | "condition" | "none";
export interface CompareColumn {
  id: string; label: string; status: string; priceCents: number;
  versusAsking?: { cents: number; bps: number; text: string };
  depositCents: number; depositPercent: number; settlementDays: number;
  conditions: string[]; conditionCount: number;
  finance: Finance; financeText: string;
  /** ISO time the owner's counter lapses, or undefined when no counter is waiting. */
  replyBy?: string;
  submittedAt: string;
  /** Which rows this offer wins. Only for facts that are clear-cut; ties award nobody when everyone is equal. */
  best: { price: boolean; deposit: boolean; settlement: boolean; conditions: boolean };
  questions: string[];
}
export interface Comparison { columns: CompareColumn[]; summary: string[]; omitted: number; note: string }

export const COMPARE_NOTE = "Elena gives you a comparison and ideas, not advice. Only you can accept, counter or decline an offer, and nothing is sent until you send it.";

const FINANCE = /\b(finance|loan|mortgage|approval|pre[-\s]?approv\w*)\b/i;
const SALE_OF_OTHER = /\b(sale\s+of|sell(ing)?\s+(their|his|her|my|our)|subject\s+to\s+(the\s+)?sale|contingent\s+on\s+(the\s+)?sale)\b/i;
const BUILDING = /\b(building|pest|inspection)\b/i;

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

function financeOf(o: CompareInput): { finance: Finance; text: string } {
  const cond = o.conditions.some(c => FINANCE.test(c));
  if (o.prequal?.state === "verified") return { finance: "verified", text: cond ? "Pre-approval verified, but the offer is still subject to finance" : "Pre-approval verified" };
  if (o.prequal?.state === "pending") return { finance: "pending", text: "Pre-approval shared, not yet verified" };
  if (cond) return { finance: "condition", text: "Subject to finance, no verified pre-approval" };
  return { finance: "none", text: "No finance condition, no pre-approval shared" };
}

/** Questions the owner might put to this buyer (in the enquiry thread). No amounts, no other buyer's terms. At most four. */
export function questionsFor(o: CompareInput, askingCents: number | undefined): string[] {
  const q: string[] = [];
  const f = financeOf(o).finance;
  if (f === "condition") q.push("Can you share a pre-approval letter, and how long will the finance condition take to clear?");
  if (f === "none" && !o.conditions.length) q.push("Is the finance already approved, and can you share a pre-approval?");
  if (o.conditions.some(c => SALE_OF_OTHER.test(c))) q.push("Is your own property under contract yet, and when is it expected to settle?");
  if (o.conditions.some(c => BUILDING.test(c))) q.push("When will the building and pest inspections be done, and what would make you walk away?");
  if (depositBps(o) < 500) q.push("Is there room to lift the deposit?");
  if (o.settlementDays > 90) q.push("Is the settlement date firm, or is there room to bring it forward?");
  const gap = versusAsking(o.priceCents, askingCents);
  if (gap && gap.bps <= -500) q.push("Is there room to move on price?");
  if (o.conditions.length >= 4) q.push("Which of your conditions matter most to you?");
  return q.slice(0, 4);
}

/** Money-free sentence about how far an offer is from asking. */
function vsText(o: CompareInput, askingCents: number | undefined): CompareColumn["versusAsking"] {
  const v = versusAsking(o.priceCents, askingCents);
  if (!v) return undefined;
  return { ...v, text: v.bps === 0 ? "At asking" : `${formatBps(v.bps)} ${v.bps > 0 ? "above" : "below"} asking` };
}

/**
 * Compares the open offers (oldest is "Offer A"). Closed offers are left out. More than MAX_COMPARED are cut by newest first and counted in `omitted`.
 * `askingCents` is the listing's asking price when there is one (sales; a rent figure is weekly and compares the same way).
 */
export function compareOffers(all: readonly CompareInput[], askingCents: number | undefined): Comparison {
  const open = all.filter(o => isOpen(o.status)).sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : a.id < b.id ? -1 : 1));
  const shown = open.slice(-MAX_COMPARED);
  const omitted = open.length - shown.length;
  const top = (f: (o: CompareInput) => number, dir: 1 | -1) => {
    if (shown.length < 2) return new Set<string>();
    const best = shown.map(f).reduce((m, v) => (dir * v > dir * m ? v : m));
    const winners = shown.filter(o => f(o) === best);
    return winners.length < shown.length ? new Set(winners.map(w => w.id)) : new Set<string>();
  };
  const bestPrice = top(o => o.priceCents, 1);
  const bestDeposit = top(o => depositBps(o), 1);
  const bestSettlement = top(o => o.settlementDays, -1);
  const bestConditions = top(o => o.conditions.length, -1);
  const columns: CompareColumn[] = shown.map((o, i) => {
    const fin = financeOf(o);
    return {
      id: o.id, label: `Offer ${letter(i)}`, status: o.status, priceCents: o.priceCents,
      ...(vsText(o, askingCents) ? { versusAsking: vsText(o, askingCents)! } : {}),
      depositCents: o.depositCents, depositPercent: depositBps(o) / 100, settlementDays: o.settlementDays,
      conditions: [...o.conditions], conditionCount: o.conditions.length, finance: fin.finance, financeText: fin.text,
      ...(o.openCounter ? { replyBy: o.openCounter.expiresAt } : {}), submittedAt: o.submittedAt,
      best: { price: bestPrice.has(o.id), deposit: bestDeposit.has(o.id), settlement: bestSettlement.has(o.id), conditions: bestConditions.has(o.id) },
      questions: questionsFor(o, askingCents)
    };
  });
  return { columns, summary: summaryFor(columns), omitted, note: COMPARE_NOTE };
}

const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(cents / 100);

/** Plain-language read-out, a few sentences. Uses only the owner's own offers. */
export function summaryFor(cols: readonly CompareColumn[]): string[] {
  if (cols.length === 0) return ["There are no open offers to compare yet."];
  if (cols.length === 1) return [`${cols[0]!.label} is the only open offer. Elena has listed the questions worth asking it below.`];
  const out: string[] = [];
  const byPrice = [...cols].sort((a, b) => b.priceCents - a.priceCents);
  const hi = byPrice[0]!, next = byPrice[1]!;
  if (hi.priceCents === next.priceCents) out.push(`${hi.label} and ${next.label} are level on price, so the other terms decide.`);
  else out.push(`${hi.label} is the highest price, ${aud(hi.priceCents - next.priceCents)} ahead of the next offer.`);
  const reasons = [hi.finance === "condition" ? "is subject to finance without a verified pre-approval" : "", hi.conditionCount >= 3 ? `has ${hi.conditionCount} conditions` : ""].filter(Boolean);
  if (reasons.length) out.push(`The highest price ${reasons.join(" and ")}, so it may be less certain than it looks.`);
  const clean = cols.filter(c => c.conditionCount === 0 && c.finance !== "condition");
  if (clean.length === 1 && clean[0]!.id !== hi.id) out.push(`${clean[0]!.label} has no conditions, which can mean a surer sale.`);
  const fastest = [...cols].sort((a, b) => a.settlementDays - b.settlementDays)[0]!;
  if (fastest.settlementDays !== Math.max(...cols.map(c => c.settlementDays))) out.push(`${fastest.label} settles soonest, in ${fastest.settlementDays} days.`);
  const soon = cols.filter(c => c.replyBy).sort((a, b) => (a.replyBy! < b.replyBy! ? -1 : 1))[0];
  if (soon) out.push(`Your counter to ${soon.label} lapses on ${new Date(soon.replyBy!).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" })}.`);
  return out;
}

// ---- Counter-offer draft ---------------------------------------------------------------------------------------------------------

export interface CounterDraft {
  scenario: Scenario["key"]; label: string; terms: CounterInput; reasoning: string[]; closeProbability: number; withinMandate: boolean;
}
export const COUNTER_DRAFT_NOTE = "This is a draft for you to change. Nothing is sent or accepted until you press send on the counter yourself.";

/**
 * Turns one of the coach's scenarios into counter terms for the owner's form. The deposit is the scenario's share of the price; the reply time
 * is kept inside the counter rules. Fails (undefined) if the terms would not pass the same checks as a counter the owner types by hand.
 * Never returns the floor price: the scenario was already clamped by the coach, and only its outcome is used here.
 */
export function counterDraftFrom(s: Scenario): CounterDraft | undefined {
  const r = parseCounterInput({
    priceCents: s.priceCents, depositCents: Math.round((s.priceCents * s.depositPercent) / 100), settlementDays: s.settlementDays,
    conditions: s.conditionsKept.map(c => c.slice(0, 200)).slice(0, 10), expiresInDays: Math.min(14, Math.max(1, Math.round(s.expiryDays)))
  });
  if (!r.ok) return undefined;
  return { scenario: s.key, label: s.label, terms: r.value, reasoning: s.reasoning.slice(0, 4), closeProbability: s.closeProbability, withinMandate: s.withinMandate };
}
