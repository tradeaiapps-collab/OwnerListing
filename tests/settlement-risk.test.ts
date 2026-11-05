import { describe, expect, it } from "vitest";
import { assessRisk, bandOf, historyReason, trendOf, type RiskInput } from "../src/domain/settlement-risk";
import type { RiskMilestone } from "../src/domain/settlement-risk";
import { STAGES } from "../src/domain/settlement";

const TODAY = "2026-11-20";
function ms(over: Partial<Record<(typeof STAGES)[number], Partial<RiskMilestone>>> = {}): RiskMilestone[] {
  return STAGES.map((stage, i) => ({ stage, status: i === 0 ? "completed" : "pending", targetDate: null, actualDate: i === 0 ? "2026-11-01" : null, ...over[stage] }) as RiskMilestone);
}
const calm = (o: Partial<RiskInput> = {}): RiskInput => ({
  today: TODAY, currentStage: "deposit_received", daysInStage: 1, stageBlocked: false, milestones: ms(), daysSinceAccepted: 2, financeNeedsConfirmed: true, buyerInterestConfirmed: false,
  openMajorFindings: 0, oldestMajorFindingDays: 0, inspectionReschedules: 0, competingOffers: 0, soldBelowAsking: false, openCase: "none", ...o
});

describe("settlement risk scoring", () => {
  it("starts at the 20 point base with no warnings", () => {
    const a = assessRisk(calm());
    expect(a.score).toBe(20);
    expect(a.band).toBe("low");
    expect(a.primary).toBeNull();
    expect(a.predictedFallthroughDate).toBeNull();
    expect(a.recommendation).toMatch(/no action/i);
  });

  it("adds 15 for finance past its target and 25 once it is more than 7 days late", () => {
    const f = (target: string) => assessRisk(calm({ currentStage: "finance_approval", milestones: ms({ inspection_completed: { status: "completed", actualDate: "2026-11-10" }, finance_approval: { targetDate: target } }) }));
    expect(f("2026-11-19").score).toBe(35);
    expect(f("2026-11-13").score).toBe(35);
    expect(f("2026-11-12").score).toBe(45);
    expect(f("2026-11-12").factors[0]!.detail).toBe("Finance approval is 8 days past its target date.");
    expect(f("2026-11-21").score).toBe(20);
  });

  it("adds 20 for open major defects and mentions a long wait for a response", () => {
    const a = assessRisk(calm({ openMajorFindings: 2, oldestMajorFindingDays: 9 }));
    expect(a.score).toBe(40);
    expect(a.primary?.key).toBe("inspection_defects");
    expect(a.reason).toContain("2 major or critical findings");
    expect(a.reason).toContain("9 days");
  });

  it("adds 10 per inspection reschedule, counting at most 3", () => {
    expect(assessRisk(calm({ inspectionReschedules: 1 })).score).toBe(30);
    expect(assessRisk(calm({ inspectionReschedules: 2 })).score).toBe(40);
    expect(assessRisk(calm({ inspectionReschedules: 7 })).score).toBe(50);
  });

  it("adds 25 for a competing offer and for an open dispute", () => {
    expect(assessRisk(calm({ competingOffers: 1 })).score).toBe(45);
    expect(assessRisk(calm({ openCase: "disputed" })).score).toBe(45);
  });

  it("takes 10 off when the deal is below asking", () => {
    expect(assessRisk(calm({ soldBelowAsking: true })).score).toBe(10);
    const a = assessRisk(calm({ soldBelowAsking: true, competingOffers: 1 }));
    expect(a.score).toBe(35);
    expect(a.primary?.key).toBe("competing_offers");
  });

  it("flags cooling-off ending with no buyer confirmation, only while it is still unconfirmed", () => {
    const m = ms({ cooling_off_expires: { targetDate: "2026-11-21" } });
    const a = assessRisk(calm({ milestones: m }));
    expect(a.primary?.key).toBe("cooling_off");
    expect(a.reason).toContain("ends in 1 day");
    expect(assessRisk(calm({ milestones: m, buyerInterestConfirmed: true })).score).toBe(20);
    expect(assessRisk(calm({ milestones: ms({ cooling_off_expires: { targetDate: "2026-11-28" } }) })).score).toBe(20);
    expect(assessRisk(calm({ milestones: ms({ cooling_off_expires: { targetDate: "2026-11-18" } }) })).reason).toContain("ended 2 days ago");
  });

  it("flags a blocked or stalled stage, and the two stage checks", () => {
    expect(assessRisk(calm({ stageBlocked: true })).score).toBe(30);
    expect(assessRisk(calm({ daysInStage: 6 })).score).toBe(25);
    expect(assessRisk(calm({ financeNeedsConfirmed: false, daysSinceAccepted: 4 })).primary?.key).toBe("finance_not_requested");
    expect(assessRisk(calm({ financeNeedsConfirmed: false, daysSinceAccepted: 3 })).score).toBe(20);
    expect(assessRisk(calm({ currentStage: "finance_approval" })).primary?.key).toBe("inspection_pending");
  });

  it("goes high, predicts a fall-through day, and recommends the biggest factor's action", () => {
    const a = assessRisk(calm({
      currentStage: "finance_approval", openMajorFindings: 1, oldestMajorFindingDays: 6, competingOffers: 1,
      milestones: ms({ inspection_completed: { status: "completed", actualDate: "2026-11-10" }, finance_approval: { targetDate: "2026-11-12" }, lawyer_exchange: { targetDate: "2026-11-25" } })
    }));
    expect(a.score).toBe(90);
    expect(a.band).toBe("high");
    expect(a.headline).toBe("Settlement at high risk (90% fallthrough probability)");
    expect(a.predictedFallthroughDate).toBe("2026-11-23");
    expect(a.recommendation).toBe("Contact the buyer today to confirm financing status.");
    const near = assessRisk(calm({ currentStage: "finance_approval", openMajorFindings: 1, competingOffers: 1, milestones: ms({ inspection_completed: { status: "completed", actualDate: "2026-11-10" }, finance_approval: { targetDate: "2026-11-12" }, lawyer_exchange: { targetDate: "2026-11-22" } }) }));
    expect(near.predictedFallthroughDate).toBe("2026-11-22");
  });

  it("keeps the score between 1 and 100", () => {
    const worst = assessRisk(calm({ currentStage: "finance_approval", stageBlocked: true, openMajorFindings: 3, inspectionReschedules: 5, competingOffers: 4, openCase: "disputed", milestones: ms({ finance_approval: { targetDate: "2026-01-01" } }) }));
    expect(worst.score).toBe(100);
  });

  it("bands, trends and history reasons", () => {
    expect([bandOf(34), bandOf(35), bandOf(59), bandOf(60)]).toEqual(["low", "medium", "medium", "high"]);
    expect([trendOf(50, null), trendOf(51, 50), trendOf(60, 50), trendOf(40, 50)]).toEqual(["same", "same", "worse", "better"]);
    expect([historyReason("finance_condition"), historyReason("building_pest_condition"), historyReason("buyer_default"), historyReason("seller_default"), historyReason(null)])
      .toEqual(["financing_denied", "inspection_issues", "buyer_backed_out", "other", "other"]);
  });
});
