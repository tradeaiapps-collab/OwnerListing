/**
 * Mortgage estimate maths (pure, AUD). Principal-and-interest loan, monthly repayments, standard annuity formula.
 * An estimate only: it ignores offset accounts, fees, stamp duty, lenders' assessment rates and lenders mortgage insurance.
 */
export const TERMS = [15, 20, 25, 30] as const;
export type Term = (typeof TERMS)[number];

export interface MortgageInput {
  price: number;           // purchase price, dollars
  downPct: number;         // deposit as % of price, 0 to 100
  ratePct: number;         // annual interest rate, %
  termYears: number;
  annualTax: number;       // council + water rates, dollars a year
  annualInsurance: number; // building/home insurance, dollars a year
}

export interface MortgageResult {
  loan: number; deposit: number; lvrPct: number;
  monthlyPI: number; monthlyTax: number; monthlyInsurance: number; monthlyTotal: number;
  totalPI: number; totalInterest: number; totalPaid: number;
  /** First-month split of the repayment, to show how much is interest early on. */
  firstMonthInterest: number; firstMonthPrincipal: number;
  /** Shares (0 to 1) of everything paid over the term: principal, interest, tax + insurance. */
  shares: { principal: number; interest: number; other: number };
  lmiLikely: boolean;
}

export const LIMITS = { maxPrice: 100_000_000, maxRate: 25, maxAnnual: 1_000_000 } as const;

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const cents = (n: number) => Math.round(n * 100) / 100;

/** Monthly repayment on `principal` at `ratePct` a year over `termYears`. Zero rate divides the loan evenly. */
export function monthlyPayment(principal: number, ratePct: number, termYears: number): number {
  const n = Math.max(1, Math.round(termYears * 12));
  if (!(principal > 0)) return 0;
  const r = ratePct / 100 / 12;
  if (r <= 0) return principal / n;
  return (principal * r) / (1 - Math.pow(1 + r, -n));
}

export function calculateMortgage(input: MortgageInput): MortgageResult {
  const price = clamp(input.price, 0, LIMITS.maxPrice);
  const downPct = clamp(input.downPct, 0, 100);
  const ratePct = clamp(input.ratePct, 0, LIMITS.maxRate);
  const termYears = clamp(Math.round(input.termYears), 1, 40);
  const annualTax = clamp(input.annualTax, 0, LIMITS.maxAnnual);
  const annualInsurance = clamp(input.annualInsurance, 0, LIMITS.maxAnnual);
  const deposit = cents((price * downPct) / 100);
  const loan = cents(price - deposit);
  const n = termYears * 12;
  const pi = monthlyPayment(loan, ratePct, termYears);
  const monthlyTax = annualTax / 12, monthlyInsurance = annualInsurance / 12;
  const totalPI = pi * n;
  const totalInterest = Math.max(0, totalPI - loan);
  const totalOther = (annualTax + annualInsurance) * termYears;
  const totalPaid = totalPI + totalOther;
  const firstMonthInterest = loan * (ratePct / 100 / 12);
  const sum = loan + totalInterest + totalOther;
  return {
    loan, deposit, lvrPct: price > 0 ? cents((loan / price) * 100) : 0,
    monthlyPI: cents(pi), monthlyTax: cents(monthlyTax), monthlyInsurance: cents(monthlyInsurance),
    monthlyTotal: cents(pi + monthlyTax + monthlyInsurance),
    totalPI: cents(totalPI), totalInterest: cents(totalInterest), totalPaid: cents(totalPaid),
    firstMonthInterest: cents(Math.min(firstMonthInterest, pi)), firstMonthPrincipal: cents(Math.max(0, pi - firstMonthInterest)),
    shares: sum > 0 ? { principal: loan / sum, interest: totalInterest / sum, other: totalOther / sum } : { principal: 0, interest: 0, other: 0 },
    lmiLikely: loan > 0 && price > 0 && loan / price > 0.8
  };
}

/** Parses a form field ("1,250.50", "$800000") to a non-negative number; anything else is 0. */
export function parseAmount(s: string): number {
  const v = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Fallbacks when the visitor leaves a field alone: typical-order-of-magnitude examples, labelled as such in the UI. */
export const DEFAULTS = { downPct: 20, termYears: 30, annualTax: 2400, annualInsurance: 1600, ratePct: 6.2 } as const;

/** One-line estimate for a listing: "From about $3,950/month". Sale listings only; undefined when it cannot be worked out. */
export function monthlyEstimate(priceCents: number | undefined, ratePct: number = DEFAULTS.ratePct): number | undefined {
  if (!priceCents || priceCents <= 0) return undefined;
  const r = calculateMortgage({ price: priceCents / 100, downPct: DEFAULTS.downPct, ratePct, termYears: DEFAULTS.termYears, annualTax: 0, annualInsurance: 0 });
  return Math.round(r.monthlyPI);
}

// ---- RBA table F5 (indicator lending rates) CSV parsing ----
export interface RateObservation { date: string; ratePct: number }
export const RATE_SERIES = "owner_occupier_variable";
/** F5 series: banks' standard variable housing rate, owner-occupier. */
const SERIES_ID = "FILRHLBVS";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function parseRbaDate(s: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[2]!.toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (const ch of line) {
    if (ch === '"') q = !q; else if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** Reads the standard variable owner-occupier column of an RBA F5 CSV. Returns [] when the column cannot be found. */
export function parseRbaF5(csv: string): RateObservation[] {
  const rows = csv.replace(/^﻿/, "").split(/\r?\n/).map(splitCsv);
  const idRow = rows.find(r => r[0]?.toLowerCase() === "series id");
  const titleRow = rows.find(r => r[0]?.toLowerCase() === "title");
  let col = idRow ? idRow.findIndex((c, i) => i > 0 && c === SERIES_ID) : -1;
  if (col < 0 && titleRow) {
    col = titleRow.findIndex((t, i) => i > 0 && /bank/i.test(t) && /variable/i.test(t) && /standard/i.test(t) && /owner/i.test(t) && /housing/i.test(t));
  }
  if (col < 1) return [];
  const out: RateObservation[] = [];
  for (const r of rows) {
    const date = parseRbaDate(r[0] ?? "");
    const v = r[col];
    if (!date || v === undefined || v === "") continue;
    const ratePct = Number(v);
    if (Number.isFinite(ratePct) && ratePct > 0 && ratePct <= LIMITS.maxRate) out.push({ date, ratePct });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
