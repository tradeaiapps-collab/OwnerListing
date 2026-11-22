/**
 * Returns and yield maths (pure, AUD). Illustrative only: not financial, tax or legal advice.
 * Two calculators share this file: a property (rental) model and a project (investor offering) model.
 * Every input is the visitor's own assumption; nothing here is a forecast or a promise of return.
 */
import { monthlyPayment } from "./mortgage";

export const RETURNS_DISCLAIMER =
  "Illustrative only, not financial, tax or legal advice. The figures come from the assumptions you enter, not from a forecast. Actual results will differ. Speak to a licensed adviser before you invest.";

export const RETURN_LIMITS = { maxPrice: 100_000_000, maxYears: 30, maxPct: 100, maxAnnual: 10_000_000 } as const;

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const dollars = (n: number) => Math.round(n * 100) / 100;
const pct2 = (n: number) => Math.round(n * 100) / 100;

export interface PropertyInput {
  price: number;            // purchase price
  upfrontCosts: number;     // stamp duty, legals, inspections: dollars
  weeklyRent: number;
  vacancyPct: number;       // share of the year with no tenant
  councilWaterYearly: number;
  insuranceYearly: number;
  maintenanceYearly: number;
  managementFeePct: number; // of rent collected
  depositPct: number;       // 0 means buying with cash
  ratePct: number;
  termYears: number;
  rentGrowthPct: number;
  valueGrowthPct: number;
  costGrowthPct: number;    // growth in running costs
  holdYears: number;
  sellingCostPct: number;   // agent and legal fees on sale, of sale price
  marginalTaxPct: number;   // 0 to ignore tax
  lossesOffsetIncome: boolean; // whether a taxable loss reduces tax on other income
}

export interface YearRow { year: number; rent: number; costs: number; interest: number; tax: number; cashFlow: number; value: number; loanBalance: number }
export interface PropertyResult {
  annualRent: number; grossYieldPct: number; netYieldPct: number;
  loan: number; deposit: number; cashInvested: number;
  firstYearCashFlow: number; cashOnCashPct: number;
  years: YearRow[];
  saleValue: number; loanBalanceAtSale: number; saleCosts: number; capitalGainsTax: number; equityAtSale: number;
  totalProfit: number; annualisedReturnPct: number | null;
}

/** Remaining loan after `months` payments. */
export function loanBalance(loan: number, ratePct: number, termYears: number, months: number): number {
  const n = Math.round(termYears * 12);
  if (loan <= 0 || months >= n) return 0;
  const r = ratePct / 100 / 12;
  if (r <= 0) return Math.max(0, loan - (loan / n) * months);
  const pmt = monthlyPayment(loan, ratePct, termYears);
  return Math.max(0, loan * Math.pow(1 + r, months) - pmt * ((Math.pow(1 + r, months) - 1) / r));
}

/** Annualised return from dated cash flows (year 0 first). Bisection; null when no sign change or no solution. */
export function irr(flows: number[]): number | null {
  const npv = (r: number) => flows.reduce((s, f, t) => s + f / Math.pow(1 + r, t), 0);
  let lo = -0.99, hi = 10;
  if (!(npv(lo) * npv(hi) < 0)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

export function calculateProperty(input: PropertyInput): PropertyResult {
  const price = clamp(input.price, 0, RETURN_LIMITS.maxPrice);
  const upfront = clamp(input.upfrontCosts, 0, RETURN_LIMITS.maxAnnual);
  const weekly = clamp(input.weeklyRent, 0, RETURN_LIMITS.maxAnnual);
  const vac = clamp(input.vacancyPct, 0, 100) / 100;
  const mgmt = clamp(input.managementFeePct, 0, 100) / 100;
  const fixedCosts = clamp(input.councilWaterYearly, 0, RETURN_LIMITS.maxAnnual) + clamp(input.insuranceYearly, 0, RETURN_LIMITS.maxAnnual) + clamp(input.maintenanceYearly, 0, RETURN_LIMITS.maxAnnual);
  const dep = clamp(input.depositPct, 0, 100);
  const rate = clamp(input.ratePct, 0, 25);
  const term = clamp(Math.round(input.termYears), 1, 40);
  const hold = clamp(Math.round(input.holdYears), 1, RETURN_LIMITS.maxYears);
  const rentG = clamp(input.rentGrowthPct, -20, 30) / 100, valG = clamp(input.valueGrowthPct, -20, 30) / 100, costG = clamp(input.costGrowthPct, -20, 30) / 100;
  const sellPct = clamp(input.sellingCostPct, 0, 20) / 100;
  const tax = clamp(input.marginalTaxPct, 0, 60) / 100;

  const deposit = dollars((price * dep) / 100);
  const loan = dollars(price - deposit);
  const cashInvested = dollars(deposit + upfront);
  const annualPmt = monthlyPayment(loan, rate, term) * 12;
  const annualRent = weekly * 52;
  const grossYieldPct = price > 0 ? pct2((annualRent / price) * 100) : 0;
  const netOp0 = annualRent * (1 - vac) * (1 - mgmt) - fixedCosts;
  const netYieldPct = price > 0 ? pct2((netOp0 / price) * 100) : 0;

  const years: YearRow[] = [];
  const flows: number[] = [-cashInvested];
  for (let y = 1; y <= hold; y++) {
    const rent = annualRent * Math.pow(1 + rentG, y - 1) * (1 - vac);
    const costs = rent * mgmt + fixedCosts * Math.pow(1 + costG, y - 1);
    const bal0 = loanBalance(loan, rate, term, (y - 1) * 12), bal1 = loanBalance(loan, rate, term, y * 12);
    const paid = Math.min(annualPmt, bal0 + bal0 * (rate / 100)); // last-year safety
    const interest = Math.max(0, paid - (bal0 - bal1));
    const taxable = rent - costs - interest;
    const taxAmt = taxable > 0 ? taxable * tax : input.lossesOffsetIncome ? taxable * tax : 0;
    const cashFlow = rent - costs - paid - taxAmt;
    years.push({ year: y, rent: dollars(rent), costs: dollars(costs), interest: dollars(interest), tax: dollars(taxAmt), cashFlow: dollars(cashFlow), value: dollars(price * Math.pow(1 + valG, y)), loanBalance: dollars(bal1) });
    flows.push(cashFlow);
  }
  const saleValue = price * Math.pow(1 + valG, hold);
  const balAtSale = loanBalance(loan, rate, term, hold * 12);
  const saleCosts = saleValue * sellPct;
  const gain = Math.max(0, saleValue - saleCosts - (price + upfront));
  // 50% general CGT discount when held more than 12 months.
  const cgt = gain * (hold > 1 ? 0.5 : 1) * tax;
  const equity = saleValue - saleCosts - balAtSale - cgt;
  flows[flows.length - 1] = flows[flows.length - 1]! + equity;
  const cashTotal = years.reduce((s, y) => s + y.cashFlow, 0);
  const first = years[0]!.cashFlow;
  return {
    annualRent: dollars(annualRent), grossYieldPct, netYieldPct, loan, deposit, cashInvested,
    firstYearCashFlow: first, cashOnCashPct: cashInvested > 0 ? pct2((first / cashInvested) * 100) : 0,
    years, saleValue: dollars(saleValue), loanBalanceAtSale: dollars(balAtSale), saleCosts: dollars(saleCosts),
    capitalGainsTax: dollars(cgt), equityAtSale: dollars(equity),
    totalProfit: dollars(cashTotal + equity - cashInvested),
    annualisedReturnPct: cashInvested > 0 ? (() => { const r = irr(flows); return r === null ? null : pct2(r * 100); })() : null
  };
}

export interface ProjectInput {
  amount: number;
  returnPct: number;     // assumed gross return a year on the amount invested (the investor's own assumption)
  termYears: number;
  upfrontFeePct: number;
  annualFeePct: number;  // of the amount invested, each year
  taxPct: number;        // marginal tax on the return
  compound: boolean;     // whether returns are reinvested (otherwise paid out yearly)
}
export interface ProjectResult {
  amount: number; upfrontFee: number; netInvested: number; grossReturn: number; fees: number; tax: number; netProfit: number;
  finalValue: number; totalReturnPct: number; annualisedPct: number | null; breakEvenPct: number;
}

export function calculateProject(input: ProjectInput): ProjectResult {
  const amount = clamp(input.amount, 0, RETURN_LIMITS.maxPrice);
  const term = clamp(Math.round(input.termYears), 1, RETURN_LIMITS.maxYears);
  const g = clamp(input.returnPct, -100, 200) / 100, up = clamp(input.upfrontFeePct, 0, 20) / 100;
  const annFee = clamp(input.annualFeePct, 0, 20) / 100, tax = clamp(input.taxPct, 0, 60) / 100;
  const upfrontFee = amount * up;
  const net = amount - upfrontFee;
  let value = net, gross = 0, fees = upfrontFee, taxTotal = 0, cash = 0;
  for (let y = 0; y < term; y++) {
    const gr = value * g, fee = amount * annFee, taxable = gr - fee;
    const t = taxable > 0 ? taxable * tax : 0;
    gross += gr; fees += fee; taxTotal += t;
    if (input.compound) value += gr - fee - t; else cash += gr - fee - t;
  }
  const finalValue = value + cash;
  const netProfit = finalValue - amount;
  const flows = [-amount, ...Array.from({ length: term }, () => 0)];
  flows[term] = finalValue;
  return {
    amount: dollars(amount), upfrontFee: dollars(upfrontFee), netInvested: dollars(net), grossReturn: dollars(gross), fees: dollars(fees),
    tax: dollars(taxTotal), netProfit: dollars(netProfit), finalValue: dollars(finalValue),
    totalReturnPct: amount > 0 ? pct2((netProfit / amount) * 100) : 0,
    annualisedPct: amount > 0 && finalValue > 0 ? pct2((Math.pow(finalValue / amount, 1 / term) - 1) * 100) : null,
    // Gross return a year needed for fees alone to be covered (ignores tax).
    breakEvenPct: net > 0 ? pct2(((fees / term) / net) * 100) : 0
  };
}

/** Parses a form field to a number; keeps a leading minus for growth fields. "" is 0. */
export function parseNumber(s: string): number {
  const neg = s.trim().startsWith("-");
  const v = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(v) ? (neg ? -v : v) : 0;
}

export const PROPERTY_DEFAULTS = {
  upfrontPct: 5, vacancyPct: 4, councilWaterYearly: 2400, insuranceYearly: 1600, maintenanceYearly: 1500, managementFeePct: 7,
  depositPct: 20, ratePct: 6.2, termYears: 30, rentGrowthPct: 3, valueGrowthPct: 4, costGrowthPct: 3, holdYears: 10, sellingCostPct: 2.5,
  marginalTaxPct: 32.5, grossYieldGuessPct: 4
} as const;
export const TERM_OPTIONS = [10, 15, 20, 25, 30] as const;
export const PROJECT_DEFAULTS = { returnPct: 10, termYears: 3, upfrontFeePct: 2, annualFeePct: 1, taxPct: 32.5 } as const;
