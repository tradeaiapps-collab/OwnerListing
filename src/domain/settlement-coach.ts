import type { Side, Stage } from "./settlement";

/**
 * Elena's coaching on the terms of an accepted offer while the settlement is being worked out: completion date, inspection window,
 * finance, deposit. Pure rules, the same with AI off. Suggestions are advice with a reason; nothing is sent, changed or accepted here.
 * Each suggestion has an audience so the buyer never sees seller context (other offers) and the seller never sees buyer finance detail.
 * Not legal advice.
 */
export const SUGGESTION_TYPES = [
  "inspection_waived", "inspection_window_short", "settlement_too_short", "settlement_long", "finance_unverified", "finance_timeline_tight",
  "deposit_low", "subject_to_sale", "settlement_flex_trade", "price_gap_compromise"
] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];
export const isSuggestionType = (v: unknown): v is SuggestionType => typeof v === "string" && (SUGGESTION_TYPES as readonly string[]).includes(v);

export type Severity = "info" | "caution" | "risk";
export type Audience = "buyer" | "seller" | "both";

export interface CoachFacts {
  /** The caller's side, from the database. */
  side: Side;
  currentStage: Stage;
  offer: { priceCents: number; depositCents: number; settlementDays: number; conditions: readonly string[] };
  askingPriceCents: number | null;
  transactionType: "sale" | "rent";
  /** Days from acceptance to the target date for the inspection stage, if one is set. */
  inspectionTargetDays: number | null;
  buyer: { financed: boolean; verifiedPrequal: boolean; firstTime: boolean; inspectionsBooked: number };
  seller: { otherOffers: number; daysOnMarket: number | null };
}

export interface Suggestion {
  type: SuggestionType;
  severity: Severity;
  audience: Audience;
  title: string;
  /** Why Elena says this, in plain words. */
  rationale: string;
  /** Wording the person can copy into the sale's messages. They choose whether to send it. */
  template: string;
}

const FINANCE = /\bfinance\b/i;
const BUILDING = /\b(building|pest|inspection)\b/i;
const SUBJECT_SALE = /\bsale\s+of\b/i;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const hasCond = (c: readonly string[], re: RegExp) => c.some(x => re.test(x));

/** Every suggestion that applies to these facts, before filtering by audience. */
export function allSuggestions(f: CoachFacts): Suggestion[] {
  if (f.transactionType !== "sale") return [];
  const out: Suggestion[] = [];
  const { offer } = f;
  const inspection = hasCond(offer.conditions, BUILDING);
  const finance = hasCond(offer.conditions, FINANCE);

  if (!inspection && f.buyer.inspectionsBooked === 0) {
    out.push({
      type: "inspection_waived", severity: "risk", audience: "both", title: "Waiving the inspection is unusual",
      rationale: "This offer has no building and pest condition and no inspection has been booked. Most buyers inspect before they commit, and skipping it is a common reason a buyer pulls out later or asks to renegotiate.",
      template: "Could we add a building and pest inspection, completed within 7 days of the contract? It protects both of us from surprises later."
    });
  }
  if (inspection && f.inspectionTargetDays !== null && f.inspectionTargetDays < 5) {
    out.push({
      type: "inspection_window_short", severity: "caution", audience: "both", title: "The inspection window is very short",
      rationale: `The inspection is planned ${f.inspectionTargetDays} day${f.inspectionTargetDays === 1 ? "" : "s"} after acceptance. Booking an inspector and getting the report usually takes about a week.`,
      template: "Can we allow 7 to 10 days for the inspection so the report is ready before the cooling-off period ends?"
    });
  }
  if (offer.settlementDays < (finance || f.buyer.financed ? 28 : 14)) {
    out.push({
      type: "settlement_too_short", severity: "risk", audience: "both", title: "The completion timeline looks unrealistic",
      rationale: `${offer.settlementDays} days is tight${finance || f.buyer.financed ? " when a loan has to be approved and the lender needs a valuation" : ""}. Rushed settlements often slip, and a slip is a common point where sales fall through.`,
      template: `Could we move settlement to ${finance || f.buyer.financed ? 42 : 30} days? That gives time for finance, searches and the final checks.`
    });
  } else if (offer.settlementDays > 90) {
    out.push({
      type: "settlement_long", severity: "caution", audience: "seller", title: "A long settlement leaves the sale exposed",
      rationale: `${offer.settlementDays} days is a long time for a sale to stay open. The longer it runs, the more can change for the buyer (finance, circumstances, market).`,
      template: "Would you consider settling within 60 days? If you need longer, a larger deposit would help us feel comfortable."
    });
  }
  if (f.buyer.financed && !f.buyer.verifiedPrequal) {
    out.push({
      type: "finance_unverified", severity: "caution", audience: "seller", title: "The buyer's finance is not verified here",
      rationale: "The buyer is relying on a loan but has no verified pre-approval on the platform. Asking for one early removes the most common cause of a failed settlement.",
      template: "Could you share your pre-approval letter or confirm your lender's approval date? Once we have it we can move forward with confidence."
    });
  }
  if (finance && offer.settlementDays < 35 && !f.buyer.verifiedPrequal) {
    out.push({
      type: "finance_timeline_tight", severity: "caution", audience: "buyer", title: "Your finance timeline is tight",
      rationale: "Formal loan approval often takes 3 to 5 weeks. Upload your pre-approval and ask your lender for a date now, or ask for more time.",
      template: "My lender is processing the loan. Could we allow a few extra days for formal approval?"
    });
  }
  const depositShare = offer.priceCents > 0 ? offer.depositCents / offer.priceCents : 0;
  if (depositShare < 0.05) {
    out.push({
      type: "deposit_low", severity: "caution", audience: "seller", title: "The deposit is low",
      rationale: `The deposit is ${pct(depositShare)} of the price. A deposit near 10% shows commitment and covers the seller if the buyer defaults.`,
      template: "Could the deposit be raised to 10% of the price? It shows commitment and keeps the deal on track for both of us."
    });
  }
  if (hasCond(offer.conditions, SUBJECT_SALE)) {
    out.push({
      type: "subject_to_sale", severity: "risk", audience: "both", title: "The deal depends on another sale",
      rationale: "This sale only goes ahead if the buyer sells their own home first. That adds a second deal that can fail.",
      template: "Can we agree a date by which the buyer's property is under contract, and what happens if it is not?"
    });
  }
  if (f.seller.otherOffers > 0 && offer.settlementDays > 45) {
    out.push({
      type: "settlement_flex_trade", severity: "info", audience: "seller", title: "You have room to trade time for certainty",
      rationale: "There are other offers on this property. A shorter settlement or a bigger deposit can be a fair ask in return for the longer timeline.",
      template: "We could agree to the longer settlement if the deposit goes up and the finance approval date is confirmed."
    });
  }
  if (f.askingPriceCents && offer.priceCents < f.askingPriceCents * 0.9 && f.seller.daysOnMarket !== null && f.seller.daysOnMarket > 60) {
    out.push({
      type: "price_gap_compromise", severity: "info", audience: "both", title: "A middle path on price may help",
      rationale: `The offer is ${pct(1 - offer.priceCents / f.askingPriceCents)} under the asking price and the home has been listed ${f.seller.daysOnMarket} days. Meeting partway, with a clean timeline, often settles faster than holding out.`,
      template: "Could we meet closer to the middle on price if the settlement and conditions stay as they are?"
    });
  }
  return out;
}

const SEVERITY_RANK: Record<Severity, number> = { risk: 0, caution: 1, info: 2 };

/** What this side may see, most serious first. The agent sees what the seller sees. */
export function suggestionsFor(f: CoachFacts): Suggestion[] {
  const mine: Audience = f.side === "buyer" ? "buyer" : "seller";
  return allSuggestions(f)
    .filter(s => s.audience === "both" || s.audience === mine)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Negotiation is still open until the contract is exchanged. */
export const COACHING_STAGES: readonly Stage[] = ["offer_accepted", "deposit_received", "cooling_off_expires", "inspection_completed", "finance_approval", "lawyer_exchange"];
export const coachingActive = (stage: Stage, completed: boolean, fellThrough: boolean): boolean => !completed && !fellThrough && COACHING_STAGES.includes(stage);

export interface Comparison { sampleSize: number; medianDays: number; text: string }
/** "Similar deals took X days to settle", only when at least five similar settled deals exist. Similar = settlement terms within 10 days. */
export function compareHistory(settlementDays: number, settled: readonly { terms: number; days: number }[]): Comparison | null {
  const similar = settled.filter(s => Math.abs(s.terms - settlementDays) <= 10).map(s => s.days).sort((a, b) => a - b);
  if (similar.length < 5) return null;
  const mid = Math.floor(similar.length / 2);
  const median = similar.length % 2 ? similar[mid]! : Math.round((similar[mid - 1]! + similar[mid]!) / 2);
  return { sampleSize: similar.length, medianDays: median, text: `Similar offers on this platform took about ${median} days to settle (${similar.length} deals).` };
}
