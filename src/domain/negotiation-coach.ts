import { formatAud } from "./listing-details";
import { analyseOffer, OPEN_STATUSES, type OfferAnalysis, type SuggestionInput } from "./offer-suggestions";

/**
 * Elena's negotiation coach. Pure functions: the same input always gives the same advice, with AI on or off.
 *
 *  1. parseOfferText   turns a pasted offer (email, text message) into price, deposit, settlement and conditions.
 *  2. coach            analyses one offer: buyer trajectory, risk, red flags, three counter scenarios with probabilities.
 *  3. listingStrategy  multi-party view over all open offers on a listing.
 *  4. trainModel       learns the close-probability weights from past closed and failed offers.
 *  5. renderTemplate   message templates for the seller to edit and send.
 *
 * Rules that never bend: the coach suggests and never accepts; the floor price only limits a suggestion and is never written
 * into any output; one buyer's offer is never revealed to another; no buyer identity is used (only price, terms and history).
 */

// ---------------------------------------------------------------- shared types

export interface DealTerms { priceCents: number; depositCents: number; settlementDays: number; conditions: readonly string[] }
export interface DealContext { askingPriceCents?: number; rounds: number; openOffers: number; buyerRaised: boolean }

export type CoachInput = SuggestionInput & {
  /** Verification ticks only (no identity). Missing = unknown, not a risk. */
  buyerVerified?: { email: boolean; phone: boolean; id: boolean };
  /** The seller's standing ask: their last counter, or the asking price. Concession limits are measured from it. */
  standingAskCents?: number;
};

/** Offers still in play for the multi-party view. */
export const OPEN_STATUSES_FOR_STRATEGY: readonly string[] = [...OPEN_STATUSES, "buyer_countered"];

export interface AnalysisFlag { code: string; text: string }

export type ScenarioKey = "firm" | "balanced" | "quick";
export type ConcessionKind = "price" | "costs" | "settlement" | "conditions" | "deposit" | "inclusions";
export interface Concession { kind: ConcessionKind; text: string; costCents?: number }

export interface Scenario {
  key: ScenarioKey;
  label: string;
  priceCents: number;
  depositPercent: number;
  settlementDays: number;
  conditionsKept: string[];
  conditionsDropped: string[];
  expiryDays: number;
  costContributionCents: number;
  concessions: Concession[];
  /** Chance the buyer takes the counter, and chance a deal on these terms completes. closeProbability is the product. */
  acceptProbability: number;
  completionProbability: number;
  closeProbability: number;
  /** Price less any cost contribution, times closeProbability, with a small time-value discount for a long settlement. */
  expectedNetCents: number;
  withinMandate: boolean;
  reasoning: string[];
}

export interface RiskPart { key: "price" | "finance" | "timeline" | "conditions" | "verification"; score: number; note: string }
export interface RiskAssessment { score: number; level: "low" | "medium" | "high"; parts: RiskPart[] }
export interface Driver { label: string; effect: "helps" | "hurts"; points: number }
export interface Prediction { probability: number; drivers: Driver[]; source: "prior" | "learned"; trainedOn: number }
export type Momentum = "rising" | "flat" | "retreating" | "unknown";

export interface CoachResult {
  analysis: OfferAnalysis;
  likelihoodAsIs: Prediction;
  buyer: { momentum: Momentum; trajectoryCents: number[]; reserveConfidence: "low" | "medium" | "high" };
  risk: RiskAssessment;
  redFlags: AnalysisFlag[];
  /** Empty when the seller must decide personally (offer at or above asking, buyer already superseded). */
  scenarios: Scenario[];
  recommended?: ScenarioKey;
  /** Concession ideas, ordered by how cheap they are for the seller. General information, not legal advice. */
  concessionIdeas: Concession[];
  summary: string;
  model: { source: "prior" | "learned"; trainedOn: number; version: string };
}

// ---------------------------------------------------------------- 1. offer parsing

export interface ParsedOffer {
  priceCents?: number;
  depositCents?: number;
  depositPercent?: number;
  settlementDays?: number;
  conditions: string[];
  /** Phrases that try to rush the seller. Shown as red flags. */
  pressure: string[];
  missing: Array<"price" | "deposit" | "settlement">;
  /** 0 to 1: share of price, deposit and settlement that could be read. */
  confidence: number;
}

const MONEY = /(\$\s?)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(k|m|mil|million|thousand)?\b/gi;
const CONDITION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(subject\s+to\s+(the\s+)?sale|sale\s+of\s+(my|our|their)\s+(home|house|property))/i, "Subject to sale of the buyer's property"],
  [/\b(finance|financing|loan|mortgage|pre[-\s]?approv\w*|unconditional\s+approval)\b/i, "Subject to finance"],
  [/\b(building\s*(and|&|\/)?\s*pest|pest|building\s+inspection|inspection|termite)\b/i, "Subject to building and pest inspection"],
  [/\b(solicitor|conveyanc\w+|legal\s+review|contract\s+review)\b/i, "Subject to legal review of the contract"],
  [/\b(valuation|valued)\b/i, "Subject to valuation"]
];
const PRESSURE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(expires?|valid)\s+(today|tonight|tomorrow|in\s+\d+\s+hours?|within\s+\d+\s+hours?)\b/i, "The offer has a very short expiry."],
  [/\b(exploding|must\s+accept|accept\s+by|respond\s+by|answer\s+by|decide\s+by)\b/i, "The offer demands a quick answer."],
  [/\b(take\s+it\s+or\s+leave\s+it|final\s+offer|last\s+offer|won'?t\s+go\s+higher)\b/i, "The buyer says this is their final offer."],
  [/\b(cash\s+buyer|cash\s+offer)\b/i, "The buyer says cash; ask for proof of funds."]
];

const scale = (s: string | undefined) => (!s ? 1 : /^k|thousand/i.test(s) ? 1_000 : 1_000_000);

/** Reads price, deposit, settlement and conditions out of free text. Anything it cannot read is listed in `missing`. */
export function parseOfferText(text: string, hint: { askingPriceCents?: number } = {}): ParsedOffer {
  const t = text.slice(0, 4000);
  const out: ParsedOffer = { conditions: [], pressure: [], missing: [], confidence: 0 };

  let depositPercent: number | undefined;
  const pctDep = /(\d{1,2}(?:\.\d+)?)\s?%\s*(?:deposit|down)|deposit\s*(?:of|is|:)?\s*(\d{1,2}(?:\.\d+)?)\s?%/i.exec(t);
  if (pctDep) depositPercent = Number(pctDep[1] ?? pctDep[2]);

  const amounts: Array<{ cents: number; deposit: boolean }> = [];
  for (const m of t.matchAll(MONEY)) {
    const [whole, dollar, num, suffix] = m;
    const idx = m.index ?? 0;
    const next = t.slice(idx + whole.length, idx + whole.length + 12);
    if (/^\s?(%|days?|weeks?|months?|wks?)/i.test(next)) continue; // a percentage or duration, not money
    const hasComma = /,/.test(num ?? "");
    if (!dollar && !suffix && !hasComma) continue; // a bare small number is not money
    const dollars = Number((num ?? "0").replace(/,/g, "")) * scale(suffix);
    if (!Number.isFinite(dollars) || dollars < 1) continue;
    const around = `${t.slice(Math.max(0, idx - 24), idx)} ${next}`;
    amounts.push({ cents: Math.round(dollars * 100), deposit: /deposit|down\s*payment/i.test(around) });
  }
  const priceCandidates = amounts.filter(a => !a.deposit && a.cents >= 100_000);
  if (priceCandidates.length > 0) {
    // Prefer the amount closest to the asking price when we know it (a $5,000 deposit and an $850k price both appear).
    const asking = hint.askingPriceCents;
    const pick = asking !== undefined
      ? [...priceCandidates].sort((a, b) => Math.abs(a.cents - asking) - Math.abs(b.cents - asking))[0]!
      : [...priceCandidates].sort((a, b) => b.cents - a.cents)[0]!;
    out.priceCents = pick.cents;
  }
  const depAmount = amounts.find(a => a.deposit);
  if (depAmount) out.depositCents = depAmount.cents;
  if (depositPercent !== undefined) {
    out.depositPercent = depositPercent;
    if (out.priceCents !== undefined && out.depositCents === undefined) out.depositCents = Math.round((out.priceCents * depositPercent) / 100);
  } else if (out.priceCents !== undefined && out.depositCents !== undefined) {
    out.depositPercent = Math.round((out.depositCents / out.priceCents) * 1000) / 10;
  }

  const days = /(\d{1,3})\s?(day|days|d)\b[^.\n]{0,20}\bsettle\w*|\bsettle\w*[^.\n]{0,20}?(\d{1,3})\s?(day|days)\b|(\d{1,3})\s?(week|weeks|wks?)\b[^.\n]{0,20}\bsettle\w*|\bsettle\w*[^.\n]{0,20}?(\d{1,2})\s?(week|weeks|wks?)\b|(\d{1,2})\s?(month|months)\b[^.\n]{0,20}\bsettle\w*|\bsettle\w*[^.\n]{0,20}?(\d{1,2})\s?(month|months)\b/i.exec(t);
  if (days) {
    const nums = days.slice(1).filter(Boolean);
    const n = Number(nums[0]);
    const unit = (nums[1] ?? "day").toLowerCase();
    out.settlementDays = unit.startsWith("w") ? n * 7 : unit.startsWith("m") ? n * 30 : n;
  }

  for (const [re, label] of CONDITION_RULES) if (re.test(t) && !out.conditions.includes(label)) out.conditions.push(label);
  if (/\b(unconditional|no\s+conditions|without\s+conditions)\b/i.test(t) && !/\bsubject\s+to\b/i.test(t)) out.conditions = [];
  for (const [re, msg] of PRESSURE_RULES) if (re.test(t)) out.pressure.push(msg);

  if (out.priceCents === undefined) out.missing.push("price");
  if (out.depositCents === undefined && out.depositPercent === undefined) out.missing.push("deposit");
  if (out.settlementDays === undefined) out.missing.push("settlement");
  out.confidence = Math.round(((3 - out.missing.length) / 3) * 100) / 100;
  return out;
}

// ---------------------------------------------------------------- 2. the close-probability model

export const MODEL_VERSION = "negotiation-coach-v1";

/** Same order as the weights. Every feature is scaled to roughly 0..1. */
export const FEATURE_NAMES = [
  "price against asking", "short deposit", "long settlement", "number of conditions", "finance condition",
  "subject to sale", "building and pest condition", "counter rounds so far", "competing offers", "buyer has raised before"
] as const;

export interface CoachModel { version: string; bias: number; weights: number[]; source: "prior" | "learned"; trainedOn: number }

/** Hand-set starting point. With little data it stays here; training moves it only as far as the data supports. */
export const DEFAULT_MODEL: CoachModel = {
  version: MODEL_VERSION, source: "prior", trainedOn: 0, bias: 1.4,
  weights: [8, -6, -0.5, -1.0, -0.5, -0.9, -0.2, -0.6, -0.5, 0.5]
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const round2 = (v: number) => Math.round(v * 100) / 100;

const FINANCE = /\b(finance|loan|mortgage|approval|pre[-\s]?approv\w*)\b/i;
const BUILDING = /\b(building|pest|inspection|termite)\b/i;
const SUBJECT_SALE = /\b(subject\s+to\s+(the\s+)?sale|sale\s+of\s+(my|our|their)\s+(home|house|property))\b/i;

export function featuresOf(t: DealTerms, c: DealContext): number[] {
  const gap = c.askingPriceCents ? (t.priceCents - c.askingPriceCents) / c.askingPriceCents : 0;
  const depositShort = t.priceCents > 0 ? Math.max(0, 0.1 - t.depositCents / t.priceCents) : 0;
  return [
    clamp(gap, -0.4, 0.2),
    clamp(depositShort, 0, 0.1),
    clamp(Math.max(0, t.settlementDays - 45) / 60, 0, 2),
    clamp(t.conditions.length, 0, 6) / 6,
    t.conditions.some(x => FINANCE.test(x)) ? 1 : 0,
    t.conditions.some(x => SUBJECT_SALE.test(x)) ? 1 : 0,
    t.conditions.some(x => BUILDING.test(x)) ? 1 : 0,
    clamp(c.rounds, 0, 5) / 5,
    clamp(c.openOffers - 1, 0, 3) / 3,
    c.buyerRaised ? 1 : 0
  ];
}

const DRIVER_TEXT: Array<[helps: string, hurts: string]> = [
  ["The price is close to or above asking.", "The price is below asking."],
  ["", "The deposit is under 10%."],
  ["", "Settlement is longer than the usual 45 days."],
  ["", "The offer has several conditions."],
  ["", "The offer depends on the buyer's finance."],
  ["", "The offer depends on the buyer selling another property."],
  ["", "The offer depends on a building and pest inspection."],
  ["", "Several counter rounds have already passed."],
  ["", "Other offers are competing for the same property."],
  ["The buyer has raised their offer before.", ""]
];

/** Chance (0 to 1) that these terms end in an exchanged contract. `skip` zeroes features, e.g. the price when scoring a counter. */
export function predictClose(model: CoachModel, x: readonly number[], skip: readonly number[] = []): Prediction {
  let z = model.bias;
  const contributions: Driver[] = [];
  x.forEach((v, i) => {
    if (skip.includes(i)) return;
    const w = model.weights[i] ?? 0;
    z += w * v;
    const points = round2(w * v);
    if (Math.abs(points) >= 0.1) {
      const text = DRIVER_TEXT[i]![points > 0 ? 0 : 1];
      if (text) contributions.push({ label: text, effect: points > 0 ? "helps" : "hurts", points });
    }
  });
  contributions.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { probability: round2(sigmoid(z)), drivers: contributions.slice(0, 4), source: model.source, trainedOn: model.trainedOn };
}

export interface TrainingSample { x: number[]; y: 0 | 1 }
export const MIN_TRAINING_SAMPLES = 30;
export const MIN_PER_CLASS = 5;
/** How many "pseudo observations" the prior is worth. More data than this and the data wins. */
const PRIOR_STRENGTH = 25;

/**
 * Logistic regression by gradient descent, pulled towards `prior` (L2 on the distance from the prior weights).
 * Fewer than 30 samples, or fewer than 5 of either outcome, returns the prior unchanged. Deterministic.
 */
export function trainModel(samples: readonly TrainingSample[], prior: CoachModel = DEFAULT_MODEL): CoachModel {
  const pos = samples.filter(s => s.y === 1).length;
  const n = samples.length;
  if (n < MIN_TRAINING_SAMPLES || pos < MIN_PER_CLASS || n - pos < MIN_PER_CLASS) return { ...prior, weights: [...prior.weights] };
  const w = [...prior.weights];
  let b = prior.bias;
  const lambda = PRIOR_STRENGTH / n;
  for (let iter = 0; iter < 400; iter++) {
    const gw = w.map(() => 0);
    let gb = 0;
    for (const s of samples) {
      const err = sigmoid(b + s.x.reduce((acc, v, i) => acc + (w[i] ?? 0) * v, 0)) - s.y;
      gb += err;
      s.x.forEach((v, i) => { gw[i]! += err * v; });
    }
    b -= 0.4 * (gb / n + lambda * (b - prior.bias));
    for (let i = 0; i < w.length; i++) w[i]! -= 0.4 * (gw[i]! / n + lambda * (w[i]! - prior.weights[i]!));
  }
  return { version: MODEL_VERSION, source: "learned", trainedOn: n, bias: Math.round(b * 1000) / 1000, weights: w.map(v => Math.round(v * 1000) / 1000) };
}

/** Brier score (lower is better) and accuracy at 0.5, so a retrain can be compared with the model it replaces. */
export function evaluateModel(model: CoachModel, samples: readonly TrainingSample[]): { brier: number; accuracy: number } {
  if (samples.length === 0) return { brier: 0, accuracy: 0 };
  let brier = 0, hits = 0;
  for (const s of samples) {
    const p = predictClose(model, s.x).probability;
    brier += (p - s.y) ** 2;
    if ((p >= 0.5 ? 1 : 0) === s.y) hits++;
  }
  return { brier: Math.round((brier / samples.length) * 1000) / 1000, accuracy: Math.round((hits / samples.length) * 1000) / 1000 };
}

// ---------------------------------------------------------------- 3. the buyer's trajectory and the bargaining model

const stepFor = (tx: "sale" | "rent", cents: number) => (tx === "rent" ? 500 : cents >= 200_000_000 ? 1_000_000 : 100_000);
const roundTo = (cents: number, step: number) => Math.round(cents / step) * step;
const roundUp = (cents: number, step: number) => Math.ceil(cents / step) * step;

/** The buyer's own prices on this listing, oldest first, ending with the current offer. */
export function trajectoryOf(input: Pick<CoachInput, "offer" | "buyerHistory">): number[] {
  const all = [...input.buyerHistory.map(h => ({ p: h.priceCents, at: h.submittedAt })), { p: input.offer.priceCents, at: input.offer.submittedAt }];
  return all.sort((a, b) => a.at.localeCompare(b.at)).map(x => x.p);
}

export function momentumOf(trajectory: readonly number[]): Momentum {
  if (trajectory.length < 2) return "unknown";
  const last = trajectory[trajectory.length - 1]!, prev = trajectory[trajectory.length - 2]!;
  if (last > prev) return "rising";
  if (last < prev) return "retreating";
  return "flat";
}

/**
 * The most the buyer is likely to pay. Concession sizes in bargaining usually shrink round by round, so the remaining room is the
 * geometric tail of the buyer's last step. With no history the estimate falls back to a share of the gap to asking.
 * Used only inside the coach; it is never shown or sent to anyone.
 */
export function estimateBuyerReserve(trajectory: readonly number[], askingCents: number | undefined, competing: number): { cents: number; confidence: "low" | "medium" | "high" } {
  const cur = trajectory[trajectory.length - 1]!;
  const cap = askingCents !== undefined ? Math.round(askingCents * (competing > 0 ? 1.03 : 1)) : undefined;
  const limit = (v: number) => Math.max(cur, cap !== undefined ? Math.min(v, cap) : v);
  const steps: number[] = [];
  for (let i = 1; i < trajectory.length; i++) steps.push(trajectory[i]! - trajectory[i - 1]!);
  const ups = steps.filter(s => s > 0);
  if (ups.length >= 2) {
    const last = ups[ups.length - 1]!, prev = ups[ups.length - 2]!;
    const r = clamp(last / prev, 0.1, 0.85);
    return { cents: limit(cur + (last * r) / (1 - r)), confidence: "high" };
  }
  if (ups.length === 1) return { cents: limit(cur + ups[0]! * 1.5), confidence: "medium" };
  if (askingCents === undefined || askingCents <= cur) return { cents: cur, confidence: "low" };
  return { cents: limit(cur + (askingCents - cur) * (0.45 + (competing > 0 ? 0.1 : 0))), confidence: "low" };
}

/** Asymmetric Nash bargaining: the seller's share of the zone between the two reserves grows with competing interest. */
export function nashPrice(sellerReserve: number, buyerReserve: number, competing: number): number {
  const alpha = clamp(0.5 + 0.1 * Math.min(competing, 3), 0.3, 0.8);
  if (buyerReserve < sellerReserve) return sellerReserve;
  return Math.round(sellerReserve + alpha * (buyerReserve - sellerReserve));
}

// ---------------------------------------------------------------- 4. risk and red flags

export function assessRisk(input: CoachInput): RiskAssessment {
  const { offer, listing } = input;
  const asking = listing.askingPriceCents;
  const gap = asking ? (offer.priceCents - asking) / asking : 0;
  const dep = offer.priceCents > 0 ? offer.depositCents / offer.priceCents : 0;
  const finance = offer.conditions.some(c => FINANCE.test(c));
  const sale = offer.conditions.some(c => SUBJECT_SALE.test(c));
  const parts: RiskPart[] = [
    { key: "price", score: Math.round(clamp(-gap / 0.2, 0, 1) * 100), note: gap < 0 ? `${Math.abs(Math.round(gap * 1000) / 10)}% below asking.` : "At or above asking." },
    { key: "finance", score: Math.round(clamp((finance ? 0.4 : 0) + Math.max(0, 0.1 - dep) * 6, 0, 1) * 100), note: finance ? "Depends on the buyer's finance." : dep < 0.05 ? "Small deposit." : "No finance condition." },
    { key: "timeline", score: Math.round(clamp((offer.settlementDays - 45) / 75, 0, 1) * 100), note: offer.settlementDays > 45 ? `${offer.settlementDays}-day settlement.` : "Settlement is within the usual time." },
    { key: "conditions", score: Math.round(clamp(offer.conditions.length * 0.2 + (sale ? 0.4 : 0), 0, 1) * 100), note: sale ? "Depends on the buyer selling another property." : `${offer.conditions.length} condition${offer.conditions.length === 1 ? "" : "s"}.` }
  ];
  const w: Record<RiskPart["key"], number> = { price: 0.3, finance: 0.25, timeline: 0.15, conditions: 0.2, verification: 0.1 };
  if (input.buyerVerified) {
    const missing = [input.buyerVerified.email, input.buyerVerified.phone, input.buyerVerified.id].filter(v => !v).length;
    parts.push({ key: "verification", score: Math.round((missing / 3) * 100), note: missing === 0 ? "Email, phone and ID are verified." : `${missing} of 3 verifications missing.` });
  }
  const used = parts.reduce((a, p) => a + w[p.key], 0);
  const score = Math.round(parts.reduce((a, p) => a + p.score * w[p.key], 0) / used);
  return { score, level: score < 30 ? "low" : score < 55 ? "medium" : "high", parts };
}

export function redFlagsFor(input: CoachInput, trajectory: readonly number[], pressure: readonly string[] = []): AnalysisFlag[] {
  const flags: AnalysisFlag[] = [];
  const { offer } = input;
  const dep = offer.priceCents > 0 ? offer.depositCents / offer.priceCents : 0;
  if (trajectory.length >= 2 && trajectory[trajectory.length - 1]! < trajectory[trajectory.length - 2]!) flags.push({ code: "buyer_retreated", text: "The buyer has lowered their offer since their last one." });
  const steps: number[] = [];
  for (let i = 1; i < trajectory.length; i++) steps.push(trajectory[i]! - trajectory[i - 1]!);
  if (steps.length >= 2 && steps.slice(-2).every(s => s > 0 && s < offer.priceCents * 0.005)) flags.push({ code: "tiny_increments", text: "The last two increases were each under half a percent, so the buyer may be testing how far you will move." });
  if (dep === 0) flags.push({ code: "no_deposit", text: "The offer has no deposit." });
  else if (dep < 0.05) flags.push({ code: "thin_deposit", text: "The deposit is under 5%, which is thin protection if the buyer pulls out." });
  if (offer.conditions.some(c => SUBJECT_SALE.test(c)) && dep < 0.1) flags.push({ code: "sale_dependent_thin", text: "The offer depends on another sale and the deposit is under 10%. Consider asking for a continue-to-market clause." });
  if (offer.settlementDays > 120) flags.push({ code: "very_long_settlement", text: `A ${offer.settlementDays}-day settlement leaves the property off the market for a long time.` });
  for (const p of pressure) flags.push({ code: "pressure", text: p });
  return flags;
}

// ---------------------------------------------------------------- 5. scenarios

const SCENARIO_LABEL: Record<ScenarioKey, string> = { firm: "Hold firm", balanced: "Meet in the middle", quick: "Close quickly" };

/** Cheap concessions first: they cost the seller little and cost the buyer's side real effort or risk. */
export function concessionIdeasFor(offer: DealTerms, tx: "sale" | "rent"): Concession[] {
  if (tx === "rent") {
    return [
      { kind: "settlement", text: "Offer a flexible move-in date." },
      { kind: "inclusions", text: "Include a small extra, such as a cleaned property or a garden service in the first month." },
      { kind: "deposit", text: "Agree to the standard bond; do not accept less." }
    ];
  }
  const ideas: Concession[] = [];
  if (offer.settlementDays > 60) ideas.push({ kind: "settlement", text: "Ask for a shorter settlement (around 45 to 60 days), or allow the full time in return for a higher deposit." });
  else ideas.push({ kind: "settlement", text: "Offer a flexible settlement date within a 30 to 60 day window. It costs you almost nothing." });
  if (offer.conditions.some(c => FINANCE.test(c))) ideas.push({ kind: "conditions", text: "Keep the finance condition but shorten it (for example 14 days) and ask for evidence of an approval in principle." });
  if (offer.conditions.some(c => SUBJECT_SALE.test(c))) ideas.push({ kind: "conditions", text: "If you keep a condition on the buyer's own sale, add a continue-to-market clause so you can accept another offer. Check the wording with your conveyancer." });
  if (offer.conditions.some(c => BUILDING.test(c))) ideas.push({ kind: "conditions", text: "Offer to share a recent building and pest report so the buyer can drop or shorten that condition." });
  if (offer.depositCents < offer.priceCents * 0.1) ideas.push({ kind: "deposit", text: "Ask for a 10% deposit to show commitment." });
  ideas.push({ kind: "inclusions", text: "Offer to leave fixtures the buyer likes (blinds, light fittings, appliances) instead of lowering the price." });
  ideas.push({ kind: "costs", text: "As a last step, offer to contribute a small amount towards the buyer's conveyancing costs rather than cutting the price further." });
  return ideas;
}

interface Built { key: ScenarioKey; price: number; deposit: number; settlement: number; keep: string[]; drop: string[]; expiry: number; contribution: number; concessions: Concession[]; why: string[] }

/** Three counters at different points on the firmness line. All clamped to the seller's limits when a mandate exists. */
export function buildScenarios(input: CoachInput, model: CoachModel = DEFAULT_MODEL): { scenarios: Scenario[]; confidence: "low" | "medium" | "high" } {
  const { offer, listing, mandate } = input;
  const tx = listing.transactionType;
  const asking = listing.askingPriceCents;
  const standing = input.standingAskCents ?? mandate?.targetPriceCents ?? asking;
  const traj = trajectoryOf(input);
  const competing = input.allOffers.filter(o => o.id !== offer.id && OPEN_STATUSES.includes(o.status)).length;
  const reserve = estimateBuyerReserve(traj, standing, competing);
  const top = standing ?? input.market?.midCents;
  if (top === undefined || top <= offer.priceCents) return { scenarios: [], confidence: reserve.confidence };

  const sellerReserve = mandate?.floorPriceCents ?? Math.round(Math.max(input.market?.lowCents ?? 0, (asking ?? top) * 0.92));
  const step = stepFor(tx, top);
  const gap = top - offer.priceCents;
  const minAllowed = mandate ? roundUp(Math.max(mandate.floorPriceCents, Math.ceil(top * (1 - mandate.maxConcessionBpsPerRound / 10_000))), step) : 0;
  const nash = nashPrice(sellerReserve, reserve.cents, competing);
  const lift = (p: number, notes: string[]) => {
    let price = clamp(roundTo(p, step), offer.priceCents + step, top);
    if (mandate && price < minAllowed) { price = Math.min(minAllowed, top); notes.push("Kept within your negotiation settings."); }
    return price;
  };

  const dropSale = offer.conditions.filter(c => SUBJECT_SALE.test(c));
  const finance = offer.conditions.filter(c => FINANCE.test(c));
  const built: Built[] = [];
  {
    const why = ["Holds close to your standing price because the room to move is small or the buyer has shown they can pay more."];
    built.push({
      key: "firm", price: lift(Math.max(nash, offer.priceCents + gap * 0.7), why), deposit: 10, settlement: Math.min(offer.settlementDays, 45),
      keep: finance.length ? finance : [], drop: offer.conditions.filter(c => !finance.includes(c)), expiry: 2, contribution: 0,
      concessions: finance.length ? [{ kind: "conditions", text: "Only a finance condition (cleared within 14 days) stays; other conditions come off." }] : offer.conditions.length ? [{ kind: "conditions", text: "Asks the buyer to drop their conditions." }] : [],
      why
    });
  }
  {
    const why = [reserve.confidence === "high" ? "Aims at where the buyer's own pattern of smaller and smaller steps suggests they will land." : "Splits the gap using an estimate of what the buyer can pay."];
    if (competing > 0) why.push("Holds a little firmer because other offers are open.");
    built.push({
      key: "balanced", price: lift(nash, why), deposit: 10, settlement: clamp(offer.settlementDays, 30, 60),
      keep: offer.conditions.filter(c => !SUBJECT_SALE.test(c)), drop: dropSale, expiry: 3, contribution: 0,
      concessions: [{ kind: "settlement", text: "Flexible settlement date in a 30 to 60 day window." }], why
    });
  }
  {
    const why = ["Moves most of the way to the buyer on price and terms to make a deal likely."];
    const price = lift(Math.max(sellerReserve, offer.priceCents + gap * 0.3), why);
    const contribution = tx === "rent" ? 0 : Math.min(roundTo(price * 0.003, 10_000), 300_000);
    built.push({
      key: "quick", price, deposit: 5, settlement: offer.settlementDays, keep: offer.conditions.filter(c => !SUBJECT_SALE.test(c)), drop: dropSale,
      expiry: 3, contribution,
      concessions: [{ kind: "settlement", text: "Accepts the buyer's settlement date." }, ...(contribution > 0 ? [{ kind: "costs" as const, text: `Contributes ${formatAud(contribution)} towards the buyer's conveyancing costs.`, costCents: contribution }] : [])], why
    });
  }

  const ctx: DealContext = { ...(asking !== undefined ? { askingPriceCents: asking } : {}), rounds: input.counterRound, openOffers: competing + 1, buyerRaised: momentumOf(traj) === "rising" };
  const flex = (days: number) => (days > 45 ? Math.round(offer.priceCents * 0.001) : 0);
  const seen = new Set<string>();
  const scenarios: Scenario[] = [];
  for (const b of built) {
    const dedupe = `${b.price}|${b.deposit}|${b.settlement}|${b.keep.join(",")}`;
    if (seen.has(dedupe)) continue; // two scenarios that came out identical add noise
    seen.add(dedupe);
    const sigma = Math.max(1, b.price * 0.012) * (reserve.confidence === "low" ? 1.5 : reserve.confidence === "medium" ? 1.2 : 0.9);
    const valueToBuyer = b.contribution + (b.key === "quick" ? flex(b.settlement) : 0) + (b.drop.length ? Math.round(b.price * 0.001) * b.drop.length : 0);
    const accept = clamp(sigmoid((reserve.cents + valueToBuyer - b.price) / sigma), 0.01, 0.99);
    const terms: DealTerms = { priceCents: b.price, depositCents: Math.round((b.price * b.deposit) / 100), settlementDays: b.settlement, conditions: b.keep };
    const complete = predictClose(model, featuresOf(terms, ctx), [0]).probability;
    const close = round2(accept * complete);
    const time = 1 / (1 + (0.06 * b.settlement) / 365);
    const net = b.price - b.contribution;
    scenarios.push({
      key: b.key, label: SCENARIO_LABEL[b.key], priceCents: b.price, depositPercent: b.deposit, settlementDays: b.settlement,
      conditionsKept: b.keep, conditionsDropped: b.drop, expiryDays: b.expiry, costContributionCents: b.contribution, concessions: b.concessions,
      acceptProbability: round2(accept), completionProbability: round2(complete), closeProbability: close,
      expectedNetCents: Math.round(net * close * time), withinMandate: !mandate || b.price >= mandate.floorPriceCents, reasoning: b.why
    });
  }
  return { scenarios, confidence: reserve.confidence };
}

export function coach(input: CoachInput, model: CoachModel = DEFAULT_MODEL): CoachResult {
  const analysis = analyseOffer(input);
  const traj = trajectoryOf(input);
  const competing = input.allOffers.filter(o => o.id !== input.offer.id && OPEN_STATUSES.includes(o.status)).length;
  const ctx: DealContext = { ...(input.listing.askingPriceCents !== undefined ? { askingPriceCents: input.listing.askingPriceCents } : {}), rounds: input.counterRound, openOffers: competing + 1, buyerRaised: momentumOf(traj) === "rising" };
  const likelihoodAsIs = predictClose(model, featuresOf(input.offer, ctx));
  const risk = assessRisk(input);
  const redFlags = redFlagsFor(input, traj);

  const superseded = analysis.flags.some(f => f.code === "likely_superseded");
  const { scenarios, confidence } = (analysis.handoff && analysis.counter === undefined) || superseded ? { scenarios: [] as Scenario[], confidence: "low" as const } : buildScenarios(input, model);
  const eligible = scenarios.filter(s => s.withinMandate);
  const best = [...eligible].sort((a, b) => b.expectedNetCents - a.expectedNetCents)[0];

  const pct = Math.round(likelihoodAsIs.probability * 100);
  const summary = scenarios.length === 0
    ? analysis.handoff
      ? `Elena: this one is your call. ${analysis.handoffReasons.join(" ")} As it stands there is about a ${pct}% chance it ends in a signed contract.`
      : `Elena: I have no counter to suggest. As it stands there is about a ${pct}% chance this ends in a signed contract.`
    : `Elena: as it stands this offer has about a ${pct}% chance of ending in a signed contract, and the risk is ${risk.level}. ${best ? `The option with the best expected result is "${best.label}" at ${formatAud(best.priceCents)} (about ${Math.round(best.closeProbability * 100)}% to close).` : ""} You decide; nothing is sent or accepted for you.`;

  return {
    analysis, likelihoodAsIs, buyer: { momentum: momentumOf(traj), trajectoryCents: traj, reserveConfidence: confidence }, risk, redFlags, scenarios,
    ...(best ? { recommended: best.key } : {}), concessionIdeas: concessionIdeasFor(input.offer, input.listing.transactionType), summary,
    model: { source: model.source, trainedOn: model.trainedOn, version: model.version }
  };
}

// ---------------------------------------------------------------- 6. several parties on one listing

export interface StrategyEntry { offerId: string; label: string; coach: CoachResult }
export interface ListingStrategy {
  ranking: Array<{ offerId: string; label: string; expectedNetCents: number; closeProbability: number; riskLevel: RiskAssessment["level"] }>;
  bestAndFinalAdvised: boolean;
  notes: string[];
}

/**
 * Compares the open offers on one listing for the seller. Each buyer is only ever shown their own terms: the notes and any
 * message built from this are for the seller, and templates never mention other offers unless the seller opts in.
 */
export function listingStrategy(entries: readonly StrategyEntry[], askingPriceCents?: number): ListingStrategy {
  const rows = entries.map(e => {
    const s = e.coach.scenarios.find(x => x.key === e.coach.recommended);
    const price = e.coach.analysis.priceCents;
    return {
      offerId: e.offerId, label: e.label, riskLevel: e.coach.risk.level,
      closeProbability: s ? s.closeProbability : e.coach.likelihoodAsIs.probability,
      expectedNetCents: s ? s.expectedNetCents : Math.round(price * e.coach.likelihoodAsIs.probability)
    };
  }).sort((a, b) => b.expectedNetCents - a.expectedNetCents || a.label.localeCompare(b.label));

  const notes: string[] = [];
  let bestAndFinal = false;
  if (rows.length >= 2) {
    const prices = entries.map(e => e.coach.analysis.priceCents).sort((a, b) => b - a);
    const close = prices[0]! > 0 && (prices[0]! - prices[1]!) / prices[0]! <= 0.03;
    if (close) {
      bestAndFinal = true;
      notes.push("The top offers are within 3% of each other. Inviting every buyer to send a highest and final offer by a set time is a common way to settle it fairly.");
    } else if (rows[0]!.expectedNetCents >= rows[1]!.expectedNetCents * 1.1) {
      notes.push(`${rows[0]!.label} is clearly ahead on expected result. Negotiate with that buyer first and keep the others informed with a neutral holding message.`);
    }
    const sale = entries.filter(e => e.coach.risk.parts.some(p => p.key === "conditions" && p.note.startsWith("Depends on the buyer selling")));
    if (sale.length > 0) notes.push(`${sale.map(e => e.label).join(", ")} depend${sale.length === 1 ? "s" : ""} on the buyer selling another property. A cash-like offer with fewer conditions may be safer even at a slightly lower price.`);
    if (rows.some(r => r.riskLevel === "high") && rows.some(r => r.riskLevel === "low")) notes.push("At least one offer is low risk. A high price from a high-risk offer is worth less than it looks.");
  } else if (rows.length === 1) {
    notes.push("There is one open offer. Without competing interest you have less leverage, so a measured counter is usually better than a firm one.");
  }
  if (askingPriceCents !== undefined && rows.length > 0 && entries.every(e => e.coach.analysis.priceCents < askingPriceCents * 0.85)) notes.push("Every offer is more than 15% below asking. Consider whether the asking price, or the campaign, needs a second look.");
  return { ranking: rows, bestAndFinalAdvised: bestAndFinal, notes };
}

// ---------------------------------------------------------------- 7. message templates

export type TemplateKind = "counter_firm" | "counter_balanced" | "counter_quick" | "best_and_final" | "request_information" | "decline_politely" | "holding_message";
export const TEMPLATE_LABEL: Record<TemplateKind, string> = {
  counter_firm: "Counter-offer: hold firm", counter_balanced: "Counter-offer: meet in the middle", counter_quick: "Counter-offer: close quickly",
  best_and_final: "Invite highest and final offer", request_information: "Ask for more detail", decline_politely: "Decline politely", holding_message: "Holding message"
};

export interface TemplateContext {
  tx: "sale" | "rent";
  offerCents: number;
  askingCents?: number;
  scenario?: Scenario;
  /** Off by default: the guard refuses text that mentions other offers unless the seller chose to say so. */
  mentionOtherOffers?: boolean;
  deadlineDays?: number;
}

const money = (c: number, tx: "sale" | "rent") => (tx === "rent" ? `${formatAud(c)} per week` : formatAud(c));
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const CLOSE = "Nothing is agreed until contracts are exchanged.";

export function renderTemplate(kind: TemplateKind, c: TemplateContext): string {
  const offer = money(c.offerCents, c.tx);
  const s = c.scenario;
  switch (kind) {
    case "counter_firm":
    case "counter_balanced":
    case "counter_quick": {
      if (!s) return "";
      const terms: string[] = [];
      terms.push(c.tx === "rent" ? "" : `a ${s.depositPercent}% deposit`);
      terms.push(c.tx === "rent" ? "" : `settlement in about ${days(s.settlementDays)}`);
      if (s.conditionsKept.length > 0) terms.push(`keeping ${s.conditionsKept.map(x => x.replace(/^Subject to /, "").toLowerCase()).join(" and ")} as the only condition${s.conditionsKept.length > 1 ? "s" : ""}`);
      else if (c.tx === "sale") terms.push("no conditions");
      const termText = terms.filter(Boolean);
      const lines = [`Thank you for your offer of ${offer}. After careful thought, the seller would like to propose ${money(s.priceCents, c.tx)}${termText.length ? `, with ${termText.join(", ")}` : ""}.`];
      if (s.costContributionCents > 0) lines.push(`To help things along, the seller is also willing to contribute ${formatAud(s.costContributionCents)} towards your conveyancing costs.`);
      lines.push(`This proposal stays open for ${days(s.expiryDays)}. If it suits you, please send a new formal offer on those terms using the offer link. ${CLOSE}`);
      return lines.join(" ");
    }
    case "best_and_final": {
      const days_ = c.deadlineDays ?? 3;
      const lead = c.mentionOtherOffers ? "The seller has received other offers and would like to give every buyer a fair chance." : "The seller would like to give you a chance to put forward your strongest position.";
      return `Thank you for your interest. ${lead} If you wish to continue, please send your highest and final offer, with your preferred deposit, settlement time and any conditions, within ${days(days_)}. ${CLOSE}`;
    }
    case "request_information":
      return `Thank you for your offer of ${offer}. To help the seller consider it, could you tell us whether your finance is approved, how much deposit you can pay, and how flexible your settlement date is? ${CLOSE}`;
    case "decline_politely":
      return `Thank you for your offer of ${offer}. The seller is not able to proceed at this price. You are welcome to send a new formal offer if your position changes. ${CLOSE}`;
    case "holding_message":
      return `Thank you for your offer of ${offer}. The seller is considering it carefully and will reply as soon as they can. ${CLOSE}`;
  }
}

export interface RenderedTemplate { kind: TemplateKind; label: string; text: string; allowedAmountsCents: number[] }

/** Every template that applies to this offer. `allowedAmountsCents` lists the amounts each text states, for the draft guard. */
export function templatesFor(result: CoachResult, tx: "sale" | "rent", offerCents: number, askingCents: number | undefined, opts: { mentionOtherOffers?: boolean; includeBestAndFinal?: boolean } = {}): RenderedTemplate[] {
  const out: RenderedTemplate[] = [];
  const base = { tx, offerCents, ...(askingCents !== undefined ? { askingCents } : {}), ...(opts.mentionOtherOffers ? { mentionOtherOffers: true } : {}) };
  const add = (kind: TemplateKind, scenario?: Scenario) => {
    const text = renderTemplate(kind, { ...base, ...(scenario ? { scenario } : {}) });
    if (!text) return;
    out.push({ kind, label: TEMPLATE_LABEL[kind], text, allowedAmountsCents: [offerCents, ...(askingCents !== undefined ? [askingCents] : []), ...(scenario ? [scenario.priceCents, ...(scenario.costContributionCents > 0 ? [scenario.costContributionCents] : [])] : [])] });
  };
  for (const s of result.scenarios) add(s.key === "firm" ? "counter_firm" : s.key === "balanced" ? "counter_balanced" : "counter_quick", s);
  if (opts.includeBestAndFinal) add("best_and_final");
  add("request_information");
  add("holding_message");
  add("decline_politely");
  return out;
}
