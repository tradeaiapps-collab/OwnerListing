import { describe, expect, it } from "vitest";
import {
  adminAnalytics, agentTotals, buildStatement, computeCommission, elenaCommissionSummary, evenSchedule, forecastEarnings, parseNewDeal,
  parseOverride, parseSchedule, parseTerms, statementCsv, unscheduledCents, type CommissionDeal, type CommissionPayout, type CommissionTerms
} from "../src/domain/commission";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const terms: CommissionTerms = { kind: "percentage", bps: 200 };
const deal = (o: Partial<CommissionDeal> = {}): CommissionDeal => ({
  id: U(1), agentUserId: U(9), agentName: "Jane Citizen", listingId: null, title: "12 Reef St", salePriceCents: 100_000_000, terms,
  calculatedCents: 2_000_000, overrideCents: null, overrideReason: null, overrideAt: null, status: "expected", dealDate: "2026-10-01",
  settlementDate: "2026-12-10", closedReason: null, createdAt: "2026-10-01T00:00:00.000Z", ...o
});
const payout = (o: Partial<CommissionPayout> = {}): CommissionPayout => ({
  id: U(50), dealId: U(1), agentUserId: U(9), dueDate: "2026-11-20", amountCents: 1_000_000, status: "scheduled", paidAt: null, paymentReference: null, ...o
});
const TODAY = "2026-11-05";

describe("commission calculation", () => {
  it("percentage: basis points of the price, rounded half up", () => {
    expect(computeCommission({ kind: "percentage", bps: 200 }, 85_000_000)).toBe(1_700_000);
    expect(computeCommission({ kind: "percentage", bps: 250 }, 1_001)).toBe(25); // 25.025 -> 25
    expect(computeCommission({ kind: "percentage", bps: 50 }, 100)).toBe(1); // 0.5 -> 1
  });
  it("fixed: the amount, whatever the price", () => {
    expect(computeCommission({ kind: "fixed", fixedCents: 500_000 }, 1)).toBe(500_000);
  });
  it("tiered: each band's rate applies only to the part of the price inside it", () => {
    const t: CommissionTerms = { kind: "tiered", tiers: [{ upToCents: 50_000_000, bps: 300 }, { upToCents: 100_000_000, bps: 200 }, { upToCents: null, bps: 100 }] };
    expect(computeCommission(t, 30_000_000)).toBe(900_000); // 3% of $300k
    expect(computeCommission(t, 50_000_000)).toBe(1_500_000);
    expect(computeCommission(t, 120_000_000)).toBe(1_500_000 + 1_000_000 + 200_000); // 3% of 500k + 2% of 500k + 1% of 200k
  });
  it("does not lose precision on very large prices", () => {
    expect(computeCommission({ kind: "percentage", bps: 9_999 }, 100_000_000_000)).toBe(99_990_000_000);
  });
});

describe("input validation", () => {
  it("accepts the three term kinds and rejects bad ones", () => {
    expect(parseTerms({ kind: "percentage", bps: 250 }).ok).toBe(true);
    expect(parseTerms({ kind: "percentage", bps: 10_001 }).ok).toBe(false);
    expect(parseTerms({ kind: "percentage", bps: 2.5 }).ok).toBe(false);
    expect(parseTerms({ kind: "fixed", fixedCents: -1 }).ok).toBe(false);
    expect(parseTerms({ kind: "fixed", fixedCents: 10.5 }).ok).toBe(false);
    expect(parseTerms({ kind: "magic" }).ok).toBe(false);
    expect(parseTerms(null).ok).toBe(false);
  });
  it("tiered bands must increase and the last band has no limit", () => {
    expect(parseTerms({ kind: "tiered", tiers: [{ upToCents: 100, bps: 300 }, { upToCents: null, bps: 200 }] }).ok).toBe(true);
    expect(parseTerms({ kind: "tiered", tiers: [{ upToCents: 100, bps: 300 }, { upToCents: 100, bps: 200 }, { upToCents: null, bps: 1 }] }).ok).toBe(false);
    expect(parseTerms({ kind: "tiered", tiers: [{ upToCents: 100, bps: 300 }] }).ok).toBe(false);
    expect(parseTerms({ kind: "tiered", tiers: [{ upToCents: null, bps: 300 }, { upToCents: null, bps: 1 }] }).ok).toBe(false);
    expect(parseTerms({ kind: "tiered", tiers: [] }).ok).toBe(false);
  });
  it("a new deal needs an agent, a title, a real price and real dates, and a schedule that adds up", () => {
    const base = { agentUserId: U(9), title: "12 Reef St", salePriceCents: 100_000_000, terms, dealDate: "2026-10-01" };
    expect(parseNewDeal(base).ok).toBe(true);
    expect(parseNewDeal({ ...base, agentUserId: "nope" }).ok).toBe(false);
    expect(parseNewDeal({ ...base, title: "  " }).ok).toBe(false);
    expect(parseNewDeal({ ...base, title: "<b>x</b>" }).ok).toBe(false);
    expect(parseNewDeal({ ...base, salePriceCents: 0 }).ok).toBe(false);
    expect(parseNewDeal({ ...base, dealDate: "2026-02-30" }).ok).toBe(false);
    expect(parseNewDeal({ ...base, settlementDate: "2026-09-01" }).ok).toBe(false);
    expect(parseNewDeal({ ...base, schedule: [{ dueDate: "2026-12-01", amountCents: 1 }] }).ok).toBe(false);
    const ok = parseNewDeal({ ...base, schedule: [{ dueDate: "2026-12-15", amountCents: 1_000_000 }, { dueDate: "2026-12-01", amountCents: 1_000_000 }] });
    expect(ok.ok && ok.value.schedule.map(p => p.dueDate)).toEqual(["2026-12-01", "2026-12-15"]);
  });
  it("an override needs a real reason and a whole non-negative amount, or null to clear", () => {
    expect(parseOverride({ overrideCents: 100, reason: "short" }).ok).toBe(false);
    expect(parseOverride({ overrideCents: -5, reason: "Agreed with the owner in writing" }).ok).toBe(false);
    expect(parseOverride({ overrideCents: 1.5, reason: "Agreed with the owner in writing" }).ok).toBe(false);
    expect(parseOverride({ overrideCents: null, reason: "Agreed with the owner in writing" })).toEqual({ ok: true, value: { overrideCents: null, reason: "Agreed with the owner in writing" } });
  });
  it("schedules are capped and need positive amounts", () => {
    expect(parseSchedule(Array.from({ length: 25 }, () => ({ dueDate: "2026-12-01", amountCents: 1 })), null).ok).toBe(false);
    expect(parseSchedule([{ dueDate: "2026-12-01", amountCents: 0 }], null).ok).toBe(false);
    expect(parseSchedule([{ dueDate: "2026-12-01", amountCents: 5 }], null).ok).toBe(true);
  });
  it("evenSchedule splits into equal payments with the odd cents on the last", () => {
    const s = evenSchedule(1_000_001, "2026-12-01", 3, 30);
    expect(s.map(p => p.dueDate)).toEqual(["2026-12-01", "2026-12-31", "2027-01-30"]);
    expect(s.reduce((t, p) => t + p.amountCents, 0)).toBe(1_000_001);
    expect(s[2]!.amountCents).toBe(333_335);
  });
});

describe("totals, statements and analytics", () => {
  const deals = [
    deal({ id: U(1), status: "earned" }),
    deal({ id: U(2), title: "Open one", status: "expected", calculatedCents: 600_000, salePriceCents: 30_000_000 }),
    deal({ id: U(3), title: "Fell over", status: "cancelled" }),
    deal({ id: U(4), title: "Adjusted", status: "earned", overrideCents: 1_500_000, overrideReason: "Negotiated down", overrideAt: "2026-10-20T00:00:00.000Z", calculatedCents: 2_000_000 })
  ];
  const payouts = [
    payout({ id: U(50), dealId: U(1), amountCents: 1_000_000, status: "paid", paidAt: "2026-10-28T02:00:00.000Z", paymentReference: "EFT 42" }),
    payout({ id: U(51), dealId: U(1), dueDate: "2026-11-20", amountCents: 500_000 }),
    payout({ id: U(52), dealId: U(4), dueDate: "2026-10-30", amountCents: 700_000 }),
    payout({ id: U(53), dealId: U(3), amountCents: 2_000_000, status: "cancelled" })
  ];
  it("effective commission uses the override, and unscheduled is what has no payment date", () => {
    const t = agentTotals(deals, payouts, TODAY);
    expect(t.earnedCents).toBe(2_000_000 + 1_500_000);
    expect(t.expectedCents).toBe(600_000);
    expect(t.paidCents).toBe(1_000_000);
    expect(t.dueCents).toBe(1_200_000);
    expect(t.overdueCents).toBe(700_000);
    expect(t.nextPayout).toEqual({ dueDate: "2026-11-20", amountCents: 500_000 });
    expect(t.openDeals).toBe(1);
    expect(t.cancelledDeals).toBe(1);
    expect(unscheduledCents(deals[0]!, payouts)).toBe(500_000);
    expect(t.unscheduledCents).toBe(500_000 + 600_000 + 800_000); // deal 1, deal 2 (nothing dated), deal 4 (1.5m - 0.7m)
  });
  it("a statement lists payments paid in the month and payments falling due in it", () => {
    const oct = buildStatement(deals, payouts, "2026-10");
    expect(oct.lines.map(l => [l.date, l.kind, l.amountCents])).toEqual([["2026-10-28", "paid", 1_000_000], ["2026-10-30", "due", 700_000]]);
    expect([oct.paidCents, oct.dueCents]).toEqual([1_000_000, 700_000]);
    expect(buildStatement(deals, payouts, "2026-01").lines).toEqual([]);
  });
  it("statement CSV quotes cells and neutralises spreadsheet formulas", () => {
    const csv = statementCsv({ month: "2026-10", paidCents: 1, dueCents: 0, lines: [{ date: "2026-10-28", dealTitle: '=HYPERLINK("x"),"hi"', kind: "paid", amountCents: 12_345, reference: null }] });
    expect(csv.split("\r\n")[0]).toBe("Date,Deal,Status,Amount (AUD),Reference");
    expect(csv).toContain(`"'=HYPERLINK(""x""),""hi"""`);
    expect(csv).toContain(",Paid,123.45,");
  });
  it("platform analytics cover status, kind, top agents, overrides and 12 months", () => {
    const a = adminAnalytics(deals, payouts, TODAY);
    expect(a.byStatus.find(s => s.status === "earned")).toEqual({ status: "earned", deals: 2, commissionCents: 3_500_000 });
    expect(a.byKind.find(k => k.kind === "percentage")?.deals).toBe(4);
    expect(a.topAgents[0]).toMatchObject({ agentName: "Jane Citizen", deals: 2, earnedCents: 3_500_000 });
    expect(a.overrides).toBe(1);
    expect(a.overduePayouts).toBe(1);
    expect(a.byMonth).toHaveLength(12);
    expect(a.byMonth[11]!.month).toBe("2026-11");
    expect(a.byMonth.find(m => m.month === "2026-10")?.paidCents).toBe(1_000_000);
  });
});

describe("forecast and Elena's summary", () => {
  it("counts dated payments in full (overdue in the current month) and open deals at the close rate", () => {
    const deals = [deal({ id: U(2), status: "expected", calculatedCents: 1_000_000, settlementDate: "2026-12-10" }), deal({ id: U(1), status: "earned" })];
    const payouts = [payout({ dealId: U(1), dueDate: "2026-10-30", amountCents: 400_000 }), payout({ id: U(51), dealId: U(1), dueDate: "2027-01-15", amountCents: 300_000 })];
    const f = forecastEarnings(deals, payouts, TODAY, 3);
    expect(f.months.map(m => m.month)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(f.months[0]).toMatchObject({ scheduledCents: 400_000, pipelineCents: 0 });
    expect(f.months[1]).toMatchObject({ scheduledCents: 0, pipelineCents: 700_000 }); // 1,000,000 x 70% default
    expect(f.months[2]!.scheduledCents).toBe(300_000);
    expect(f.closeRateBasis).toBe("default");
    expect(f.confidence).toBe("low");
  });
  it("uses the agent's own history once there are three closed deals, and ignores cancelled deals' payments", () => {
    const closed = [deal({ id: U(1), status: "earned" }), deal({ id: U(2), status: "earned" }), deal({ id: U(3), status: "cancelled" }), deal({ id: U(4), status: "earned" }), deal({ id: U(5), status: "earned" })];
    const open = deal({ id: U(6), status: "expected", calculatedCents: 1_000_000, settlementDate: "2026-11-20" });
    const f = forecastEarnings([...closed, open], [payout({ dealId: U(3), amountCents: 9_999_999 })], TODAY);
    expect(f.closeRate).toBe(0.8);
    expect(f.closeRateBasis).toBe("history");
    expect(f.confidence).toBe("medium");
    expect(f.months[0]).toMatchObject({ scheduledCents: 0, pipelineCents: 800_000 });
  });
  it("Elena's text is built from the exact figures and carries the estimate disclaimer", () => {
    const deals = [deal({ status: "earned" })];
    const payouts = [payout({ amountCents: 2_000_000, dueDate: "2026-11-20" })];
    const s = elenaCommissionSummary("Jane", agentTotals(deals, payouts, TODAY), forecastEarnings(deals, payouts, TODAY));
    expect(s.text).toContain("Hi Jane.");
    expect(s.text).toContain("$20,000.00");
    expect(s.text).toContain("November 2026");
    expect(s.disclaimer).toMatch(/not financial advice/);
  });
  it("Elena has a calm answer when there are no deals", () => {
    const s = elenaCommissionSummary("", agentTotals([], [], TODAY), forecastEarnings([], [], TODAY));
    expect(s.text).toMatch(/no commission deals recorded yet/);
    expect(s.highlights).toEqual([]);
  });
});
