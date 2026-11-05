import { describe, expect, it, vi } from "vitest";
import { calculateMortgage, monthlyEstimate, monthlyPayment, parseAmount, parseRbaF5 } from "../src/domain/mortgage";
import { refreshMortgageRates, saveRates } from "../src/server/mortgage-rates-db";

const CSV = `F5  INDICATOR LENDING RATES
Title,Housing loans; Banks; Variable; Discounted; Owner-occupier,Housing loans; Banks; Variable; Standard; Owner-occupier
Frequency,Monthly,Monthly
Series ID,FILRHLBVD,FILRHLBVS
30-Jun-2025,5.90,8.67
31-Jul-2025,5.80,
31-Aug-2025,5.75,8.52
bad-row,1,2
`;

describe("mortgage maths", () => {
  it("matches the standard annuity figure", () => {
    expect(monthlyPayment(500000, 6, 30)).toBeCloseTo(2997.75, 2);
    expect(monthlyPayment(120000, 0, 10)).toBe(1000);
    expect(monthlyPayment(0, 6, 30)).toBe(0);
  });
  it("breaks a payment into repayment, rates, insurance and totals", () => {
    const r = calculateMortgage({ price: 625000, downPct: 20, ratePct: 6, termYears: 30, annualTax: 2400, annualInsurance: 1200 });
    expect(r.loan).toBe(500000);
    expect(r.deposit).toBe(125000);
    expect(r.monthlyPI).toBeCloseTo(2997.75, 2);
    expect(r.monthlyTotal).toBeCloseTo(2997.75 + 200 + 100, 2);
    expect(r.totalInterest).toBeCloseTo(2997.75 * 360 - 500000, -1);
    expect(r.totalPaid).toBeCloseTo(2997.75 * 360 + 3600 * 30, -1);
    expect(r.firstMonthInterest).toBeCloseTo(2500, 2);
    expect(r.shares.principal + r.shares.interest + r.shares.other).toBeCloseTo(1, 6);
    expect(r.lmiLikely).toBe(false);
    expect(calculateMortgage({ price: 600000, downPct: 10, ratePct: 6, termYears: 25, annualTax: 0, annualInsurance: 0 }).lmiLikely).toBe(true);
  });
  it("survives junk and extreme input", () => {
    const r = calculateMortgage({ price: NaN, downPct: 500, ratePct: -3, termYears: 0, annualTax: Infinity, annualInsurance: -1 });
    expect(r.monthlyTotal).toBe(0);
    expect(calculateMortgage({ price: 1e15, downPct: 0, ratePct: 99, termYears: 99, annualTax: 0, annualInsurance: 0 }).monthlyPI).toBeGreaterThan(0);
    expect(parseAmount("$1,250.50")).toBe(1250.5);
    expect(parseAmount("abc")).toBe(0);
  });
  it("estimates a listing's monthly repayment", () => {
    expect(monthlyEstimate(62500000, 6)).toBe(2998);
    expect(monthlyEstimate(undefined)).toBeUndefined();
    expect(monthlyEstimate(0)).toBeUndefined();
  });
});

describe("RBA F5 parsing and refresh", () => {
  it("reads the standard variable owner-occupier column by series id and skips blanks and bad rows", () => {
    expect(parseRbaF5(CSV)).toEqual([{ date: "2025-06-30", ratePct: 8.67 }, { date: "2025-08-31", ratePct: 8.52 }]);
  });
  it("falls back to the column title when the series id is missing", () => {
    expect(parseRbaF5(CSV.replace("FILRHLBVS", "OTHER")).length).toBe(2);
  });
  it("returns nothing for an unrecognised file", () => {
    expect(parseRbaF5("a,b\n1,2")).toEqual([]);
  });
  it("stores rates and rejects a bad download", async () => {
    const calls: unknown[][] = [];
    const db = { query: vi.fn(async (_t: string, p?: unknown[]) => { calls.push(p ?? []); return { rows: [{ rate_date: "2025-08-31", rate_pct: "8.520" }] }; }) };
    expect(await saveRates(db, [{ date: "2025-08-31", ratePct: 8.52 }])).toBe(1);
    const ok = await refreshMortgageRates(db, (async () => new Response(CSV)) as typeof fetch);
    expect(ok.stored).toBe(2);
    expect(ok.latest).toEqual({ date: "2025-08-31", ratePct: 8.52 });
    await expect(refreshMortgageRates(db, (async () => new Response("no", { status: 500 })) as typeof fetch)).rejects.toThrow(/500/);
    await expect(refreshMortgageRates(db, (async () => new Response("a,b")) as typeof fetch)).rejects.toThrow(/usable/);
  });
});
