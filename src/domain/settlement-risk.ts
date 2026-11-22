import { addDays, STAGES, STAGE_LABEL, type MilestoneStatus, type Stage } from "./settlement";

/**
 * Elena's settlement risk predictor, first version: a transparent points table, not a trained model. Pure functions; src/server/settlement-risk-db.ts
 * gathers the facts. The score is an uncalibrated estimate of the chance the sale falls through (0 to 100), never a decision: nothing is blocked
 * or sent to the buyer because of it. Change a number here and bump RULES_VERSION.
 */
export const RULES_VERSION = "2026-11-05-v1";
export const BASE_RISK = 20;
export const HIGH_AT = 60;
export const MEDIUM_AT = 35;
export const MAX_RESCHEDULES_COUNTED = 3;
const DAY = 86_400_000;

export type Band = "low" | "medium" | "high";
export interface RiskFactor { key: string; label: string; points: number; detail: string; action: string }
export interface RiskMilestone { stage: Stage; status: MilestoneStatus; targetDate: string | null; actualDate: string | null }
export interface RiskInput {
  today: string;
  currentStage: Stage;
  /** Whole days the open stage has been open. */
  daysInStage: number;
  stageBlocked: boolean;
  milestones: readonly RiskMilestone[];
  /** Whole days since the offer was accepted. */
  daysSinceAccepted: number;
  /** Buyer ticked "Confirm finance needs" (offer accepted stage). */
  financeNeedsConfirmed: boolean;
  /** Agent ticked "Confirm the buyer is still interested" (cooling-off stage). */
  buyerInterestConfirmed: boolean;
  /** Major or critical inspection findings still open, and how long the oldest has waited. */
  openMajorFindings: number;
  oldestMajorFindingDays: number;
  /** Cancelled inspection bookings and inspections requested by this buyer on this listing. */
  inspectionReschedules: number;
  /** Other buyers' live offers on the same listing. */
  competingOffers: number;
  /** The agreed price is below the asking price. */
  soldBelowAsking: boolean;
  /** A fell-through case raised on this sale and not yet settled. */
  openCase: "none" | "proposed" | "disputed";
}
export interface RiskAssessment {
  score: number; band: Band; primary: RiskFactor | null; factors: RiskFactor[]; predictedFallthroughDate: string | null;
  headline: string; reason: string; recommendation: string; rulesVersion: string;
}

const days = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
export const bandOf = (score: number): Band => (score >= HIGH_AT ? "high" : score >= MEDIUM_AT ? "medium" : "low");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Every rule that applies to this settlement, biggest first. */
export function riskFactors(i: RiskInput): RiskFactor[] {
  const out: RiskFactor[] = [];
  const m = (s: Stage) => i.milestones.find(x => x.stage === s);
  const idx = STAGES.indexOf(i.currentStage);
  const add = (f: RiskFactor) => out.push(f);

  const fin = m("finance_approval");
  if (fin && fin.status !== "completed" && fin.targetDate && fin.targetDate < i.today) {
    const late = days(fin.targetDate, i.today);
    add({ key: "finance_overdue", label: "Finance approval overdue", points: late > 7 ? 25 : 15,
      detail: `Finance approval is ${plural(late, "day")} past its target date.`, action: "Contact the buyer today to confirm financing status." });
  }
  if (i.openMajorFindings > 0) {
    const waited = i.oldestMajorFindingDays > 5 ? ` and has waited ${plural(i.oldestMajorFindingDays, "day")} for a response` : "";
    add({ key: "inspection_defects", label: "Major inspection defects", points: 20,
      detail: `The inspection report has ${plural(i.openMajorFindings, "major or critical finding")} still open${waited}.`, action: "Ask the buyer how they want to handle the defects (repair, price change or proceed)." });
  }
  if (i.inspectionReschedules > 0) {
    const n = Math.min(i.inspectionReschedules, MAX_RESCHEDULES_COUNTED);
    add({ key: "inspection_reschedules", label: "Inspection rescheduled", points: 10 * n,
      detail: `The buyer cancelled or rescheduled the inspection ${plural(i.inspectionReschedules, "time")}.`, action: "Check in with the buyer and offer fixed inspection times." });
  }
  if (i.competingOffers > 0) {
    add({ key: "competing_offers", label: "Competing offers", points: 25,
      detail: `${plural(i.competingOffers, "other offer")} on this property ${i.competingOffers === 1 ? "is" : "are"} still open.`, action: "Decide with the owner how to handle the other offers, and keep the buyer informed." });
  }
  if (i.openCase !== "none") {
    add({ key: "dispute", label: i.openCase === "disputed" ? "Dispute open" : "Fall-through case raised", points: 25,
      detail: i.openCase === "disputed" ? "One side has disputed the deposit outcome." : "One side has said the sale will not complete.", action: "Contact both sides and resolve the open case before anything else moves." });
  }
  const cool = m("cooling_off_expires");
  if (cool && cool.status !== "completed" && cool.targetDate && !i.buyerInterestConfirmed && idx <= STAGES.indexOf("cooling_off_expires") && days(i.today, cool.targetDate) <= 2) {
    const left = days(i.today, cool.targetDate);
    add({ key: "cooling_off", label: "Cooling-off ending", points: 15,
      detail: left < 0 ? `The cooling-off period ended ${plural(-left, "day")} ago and the buyer has not confirmed they are going ahead.` : left === 0 ? "The cooling-off period ends today and the buyer has not confirmed they are going ahead." : `The cooling-off period ends in ${plural(left, "day")} and the buyer has not confirmed they are going ahead.`,
      action: "Ask the buyer to confirm they are going ahead before the cooling-off period ends." });
  }
  if (i.stageBlocked) add({ key: "blocked", label: "Stage blocked", points: 10, detail: `${STAGE_LABEL[i.currentStage]} is marked blocked.`, action: "Resolve what is blocking this stage." });
  else if (i.daysInStage > 5) add({ key: "stalled", label: "Stage stalled", points: 5, detail: `${STAGE_LABEL[i.currentStage]} has been open for ${plural(i.daysInStage, "day")}.`, action: "Find out what is holding up this stage." });
  // Stage-specific checks from the playbook.
  if (!i.financeNeedsConfirmed && i.daysSinceAccepted > 3 && fin && fin.status !== "completed") {
    add({ key: "finance_not_requested", label: "Finance not yet requested", points: 5, detail: "The buyer has not confirmed their finance needs since the offer was accepted.", action: "Ask the buyer to start the finance application." });
  }
  if (i.currentStage === "finance_approval" && m("inspection_completed")?.status !== "completed") {
    add({ key: "inspection_pending", label: "Inspection still pending", points: 5, detail: "Finance approval has started but the inspection is not complete.", action: "Chase the inspection report so the lender and buyer have it." });
  }
  if (i.soldBelowAsking) add({ key: "price_below_asking", label: "Agreed below asking", points: -10, detail: "The agreed price is below the asking price, which suggests a motivated seller.", action: "" });
  return out.sort((a, b) => b.points - a.points);
}

export function assessRisk(i: RiskInput): RiskAssessment {
  const factors = riskFactors(i);
  const raw = BASE_RISK + factors.reduce((s, f) => s + f.points, 0);
  const score = Math.max(1, Math.min(100, Math.round(raw)));
  const band = bandOf(score);
  const adds = factors.filter(f => f.points > 0);
  const primary = adds[0] ?? null;

  let predicted: string | null = null;
  if (band === "high") {
    const ahead = i.milestones.filter(x => x.status !== "completed" && x.targetDate && x.targetDate >= i.today).map(x => x.targetDate!).sort()[0];
    const byScore = addDays(i.today, Math.max(1, Math.ceil((100 - score) / 4)));
    predicted = ahead && ahead < byScore ? ahead : byScore;
  }
  const headline = `Settlement at ${band} risk (${score}% fallthrough probability)`;
  const reason = adds.slice(0, 2).map(f => f.detail).join(" ") || "No specific warning signs. This is the starting estimate.";
  const recommendation = adds.find(f => f.action)?.action ?? "No action needed right now.";
  return { score, band, primary, factors, predictedFallthroughDate: predicted, headline, reason, recommendation, rulesVersion: RULES_VERSION };
}

/** Score change since the last scoring: "worse", "better" or "same". Moves under 3 points are noise. */
export function trendOf(score: number, previous: number | null): "worse" | "better" | "same" {
  if (previous == null || Math.abs(score - previous) < 3) return "same";
  return score > previous ? "worse" : "better";
}

/** Maps the reason the sale fell through to the history categories. */
export function historyReason(reason: string | null): "buyer_backed_out" | "financing_denied" | "inspection_issues" | "other" {
  switch (reason) {
    case "finance_condition": return "financing_denied";
    case "building_pest_condition": return "inspection_issues";
    case "cooling_off": case "buyer_default": return "buyer_backed_out";
    default: return "other";
  }
}
