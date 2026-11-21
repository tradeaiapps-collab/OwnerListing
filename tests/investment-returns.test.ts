import { describe, expect, it } from "vitest";
import { calculateProject, calculateProperty, irr, loanBalance, parseNumber, type PropertyInput } from "../src/domain/investment-returns";

const base: PropertyInput = {
  price: 1_000_000, upfrontCosts: 50_000, weeklyRent: 1000, vacancyPct: 0, councilWaterYearly: 0, insuranceYearly: 0, maintenanceYearly: 0,
  managementFeePct: 0, depositPct: 100, ratePct: 6, termYears: 30, rentGrowthPct: 0, valueGrowthPct: 0, costGrowthPct: 0, holdYears: 5,
  sellingCostPct: 0, marginalTaxPct: 0, lossesOffsetIncome: false
};

describe("property returns", () => {
  it("computes gross and net yield", () => {
    const r = calculateProperty({ ...base, weeklyRent: 1000, vacancyPct: 10, councilWaterYearly: 2000, insuranceYearly: 1000, maintenanceYearly: 1000, managementFeePct: 10 });
    expect(r.annualRent).toBe(52000);
    expect(r.grossYieldPct).toBe(5.2);
    // 52000 * 0.9 * 0.9 - 4000 = 38120
    expect(r.netYieldPct).toBeCloseTo(3.81, 2);
  });
  it("cash purchase has no loan and cash-on-cash uses price plus upfront costs", () => {
    const r = calculateProperty(base);
    expect(r.loan).toBe(0);
    expect(r.cashInvested).toBe(1_050_000);
    expect(r.firstYearCashFlow).toBe(52000);
    expect(r.cashOnCashPct).toBeCloseTo(4.95, 2);
  });
  it("loan balance falls to zero at term and matches the annuity", () => {
    expect(loanBalance(500000, 6, 30, 360)).toBe(0);
    expect(loanBalance(500000, 6, 30, 0)).toBeCloseTo(500000, 2);
    expect(loanBalance(500000, 6, 30, 120)).toBeCloseTo(418_428.62, 1);
  });
  it("applies growth, sale costs and the CGT discount", () => {
    const r = calculateProperty({ ...base, valueGrowthPct: 5, holdYears: 10, sellingCostPct: 2, marginalTaxPct: 40 });
    expect(r.saleValue).toBeCloseTo(1_628_894.63, 0);
    expect(r.saleCosts).toBeCloseTo(32_577.89, 0);
    const gain = 1_628_894.63 - 32_577.89 - 1_050_000;
    expect(r.capitalGainsTax).toBeCloseTo(gain * 0.5 * 0.4, 0);
  });
  it("negative gearing only refunds tax when losses offset income", () => {
    const geared = { ...base, depositPct: 20, marginalTaxPct: 40, weeklyRent: 500 };
    const off = calculateProperty({ ...geared, lossesOffsetIncome: false }).years[0]!;
    const on = calculateProperty({ ...geared, lossesOffsetIncome: true }).years[0]!;
    expect(off.tax).toBe(0);
    expect(on.tax).toBeLessThan(0);
    expect(on.cashFlow).toBeGreaterThan(off.cashFlow);
  });
  it("clamps nonsense input without throwing", () => {
    const r = calculateProperty({ ...base, price: NaN, weeklyRent: -5, holdYears: 999, depositPct: 500 });
    expect(r.grossYieldPct).toBe(0);
    expect(r.years.length).toBe(30);
    expect(Number.isFinite(r.totalProfit)).toBe(true);
  });
  it("irr finds a known rate", () => {
    expect(irr([-100, 110])).toBeCloseTo(0.1, 6);
    expect(irr([100, 110])).toBeNull();
  });
});

describe("project returns", () => {
  it("pays out yearly without compounding", () => {
    const r = calculateProject({ amount: 100000, returnPct: 10, termYears: 3, upfrontFeePct: 0, annualFeePct: 0, taxPct: 0, compound: false });
    expect(r.netProfit).toBe(30000);
    expect(r.finalValue).toBe(130000);
  });
  it("compounds and takes fees and tax", () => {
    const c = calculateProject({ amount: 100000, returnPct: 10, termYears: 2, upfrontFeePct: 0, annualFeePct: 0, taxPct: 0, compound: true });
    expect(c.finalValue).toBe(121000);
    const f = calculateProject({ amount: 100000, returnPct: 10, termYears: 1, upfrontFeePct: 2, annualFeePct: 1, taxPct: 30, compound: false });
    // net 98000, gross 9800, fee 1000, tax 30% of 8800 = 2640
    expect(f.upfrontFee).toBe(2000);
    expect(f.tax).toBe(2640);
    expect(f.netProfit).toBeCloseTo(98000 + 9800 - 1000 - 2640 - 100000, 2);
  });
  it("a loss pays no tax", () => {
    const r = calculateProject({ amount: 100000, returnPct: -20, termYears: 1, upfrontFeePct: 0, annualFeePct: 0, taxPct: 30, compound: false });
    expect(r.tax).toBe(0);
    expect(r.netProfit).toBe(-20000);
  });
  it("parses numbers with signs and symbols", () => {
    expect(parseNumber("$1,250.50")).toBe(1250.5);
    expect(parseNumber("-2.5")).toBe(-2.5);
    expect(parseNumber("abc")).toBe(0);
  });
});
