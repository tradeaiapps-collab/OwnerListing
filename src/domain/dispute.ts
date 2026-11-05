import type { Result } from "./deposit-escrow";

/**
 * Buyer-seller disputes during settlement, and Elena's mediation. Pure functions: the same input always gives the same suggestion, with
 * AI on or off. src/server/dispute-db.ts does the storing. Elena suggests; only the two people (or staff after escalation) settle a dispute.
 * Money is described as the share of the disputed amount the seller covers. Nothing here moves money and nothing is legal advice.
 */
export const DISPUTE_TYPES = ["inspection", "financing", "repair", "cooling_off"] as const;
export type DisputeType = (typeof DISPUTE_TYPES)[number];
export const TYPE_LABEL: Record<DisputeType, string> = {
  inspection: "Inspection issue", financing: "Financing delay", repair: "Repair dispute", cooling_off: "Cooling-off period"
};
export const isDisputeType = (v: unknown): v is DisputeType => typeof v === "string" && (DISPUTE_TYPES as readonly string[]).includes(v);

export type Party = "buyer" | "seller";
export type DisputeStatus = "awaiting_position" | "mediating" | "agreed" | "escalated" | "resolved" | "withdrawn";
export const STATUS_LABEL: Record<DisputeStatus, string> = {
  awaiting_position: "Waiting for the other side", mediating: "Elena is mediating", agreed: "Agreed", escalated: "With staff", resolved: "Resolved by staff", withdrawn: "Withdrawn"
};
export const OPEN_STATUSES: readonly DisputeStatus[] = ["awaiting_position", "mediating", "escalated"];
export type EscalationReason = "requested" | "max_rounds" | "timeout";
export const ESCALATION_LABEL: Record<EscalationReason, string> = { requested: "A party asked for staff", max_rounds: "No agreement after 3 rounds", timeout: "No resolution after 5 days" };

export const MAX_ROUNDS = 3;
export const ESCALATE_AFTER_DAYS = 5;
export const MIN_HISTORY = 3;
export const MAX_TITLE = 120, MAX_TEXT = 2000, MAX_CLAIM_CENTS = 100_000_000_00;
const DAY = 86_400_000;

export const deadlineFor = (createdAt: Date): Date => new Date(createdAt.getTime() + ESCALATE_AFTER_DAYS * DAY);
export const isOverdue = (deadline: Date, now: Date): boolean => now.getTime() >= deadline.getTime();

// ---------- input ----------

export interface CreateInput { type: DisputeType; title: string; description: string; position: string; claimCents: number | null; sellerSharePct: number | null }
export interface PositionInput { position: string; sellerSharePct: number | null }
export type ResponseKind = "accept" | "counter" | "escalate";
export interface ResponseInput { response: ResponseKind; sellerSharePct: number | null; note: string | null }
export type DisputeAction =
  | ({ action: "position" } & PositionInput)
  | ({ action: "respond" } & ResponseInput)
  | { action: "withdraw" };

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
const pct = (v: unknown): number | null | "bad" => (v === undefined || v === null ? null : typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100 ? v : "bad");
const cents = (v: unknown): number | null | "bad" => (v === undefined || v === null ? null : typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_CLAIM_CENTS ? v : "bad");

export function parseCreate(raw: unknown): Result<CreateInput> {
  const b = rec(raw);
  if (!b) return { ok: false, error: "Send the dispute details." };
  if (!isDisputeType(b["type"])) return { ok: false, error: "Choose what the dispute is about." };
  const title = text(b["title"], MAX_TITLE), description = text(b["description"], MAX_TEXT), position = text(b["position"], MAX_TEXT);
  if (!title) return { ok: false, error: `Give the dispute a short title (up to ${MAX_TITLE} characters).` };
  if (!description) return { ok: false, error: "Describe the issue." };
  if (!position) return { ok: false, error: "Say what you want to happen." };
  const claim = cents(b["claimCents"]), share = pct(b["sellerSharePct"]);
  if (claim === "bad") return { ok: false, error: "The disputed amount must be a whole number of cents above zero." };
  if (share === "bad") return { ok: false, error: "The seller's share must be a whole number from 0 to 100." };
  if (share !== null && claim === null) return { ok: false, error: "Enter the disputed amount to say who should pay what share." };
  if (claim !== null && share === null) return { ok: false, error: "Say what share of the amount the seller should cover (0 to 100)." };
  return { ok: true, value: { type: b["type"], title, description, position, claimCents: claim, sellerSharePct: share } };
}

export function parseAction(raw: unknown, hasClaim: boolean): Result<DisputeAction> {
  const b = rec(raw);
  if (!b) return { ok: false, error: "Send an action." };
  if (b["action"] === "withdraw") return { ok: true, value: { action: "withdraw" } };
  if (b["action"] === "position") {
    const position = text(b["position"], MAX_TEXT), share = pct(b["sellerSharePct"]);
    if (!position) return { ok: false, error: "Say what you want to happen." };
    if (share === "bad") return { ok: false, error: "The seller's share must be a whole number from 0 to 100." };
    if (hasClaim && share === null) return { ok: false, error: "Say what share of the amount the seller should cover (0 to 100)." };
    return { ok: true, value: { action: "position", position, sellerSharePct: hasClaim ? share : null } };
  }
  if (b["action"] === "respond") {
    const r = b["response"];
    if (r !== "accept" && r !== "counter" && r !== "escalate") return { ok: false, error: "Choose accept, counter or ask for staff." };
    const share = pct(b["sellerSharePct"]);
    const note = b["note"] === undefined || b["note"] === null || b["note"] === "" ? null : text(b["note"], MAX_TEXT);
    if (share === "bad") return { ok: false, error: "The seller's share must be a whole number from 0 to 100." };
    if (b["note"] !== undefined && b["note"] !== null && b["note"] !== "" && note === null) return { ok: false, error: "Keep the note under 2000 characters." };
    if (r === "counter" && (hasClaim ? share === null : note === null)) return { ok: false, error: hasClaim ? "Say what share the seller should cover in your counter." : "Say what you propose instead." };
    return { ok: true, value: { action: "respond", response: r, sellerSharePct: r === "counter" && hasClaim ? share : null, note } };
  }
  return { ok: false, error: "Unknown action." };
}

// ---------- rounds ----------

export type RoundOutcome = { kind: "wait" } | { kind: "agreed" } | { kind: "next_round" } | { kind: "escalate"; reason: EscalationReason };

/** What happens once the responses to a round are in. Anyone asking for staff escalates at once; two accepts settle it; otherwise another round, up to MAX_ROUNDS. */
export function evaluateRound(round: number, buyer: ResponseKind | null, seller: ResponseKind | null): RoundOutcome {
  if (buyer === "escalate" || seller === "escalate") return { kind: "escalate", reason: "requested" };
  if (!buyer || !seller) return { kind: "wait" };
  if (buyer === "accept" && seller === "accept") return { kind: "agreed" };
  return round >= MAX_ROUNDS ? { kind: "escalate", reason: "max_rounds" } : { kind: "next_round" };
}

// ---------- Elena ----------

export interface History { samples: number; medianSellerSharePct: number }
export interface MediationInput {
  type: DisputeType; round: number; claimCents: number | null;
  /** Each side's current stance: the seller's share they want. Null when the dispute has no amount. */
  buyerSharePct: number | null; sellerSharePct: number | null;
  buyerText: string; sellerText: string; description: string;
  daysOpen: number; daysToSettlement: number | null; settlementBlocked: boolean;
  history: History | null;
}
export interface Risk { level: "low" | "medium" | "high"; likelyFallThrough: boolean; reasons: string[] }
export interface Template { label: string; text: string }
export interface Suggestion {
  round: number; headline: string; sellerSharePct: number | null; buyerSharePct: number | null; sellerPaysCents: number | null; buyerPaysCents: number | null;
  reasoning: string[]; history: History | null; risk: Risk; templates: Template[]; disclaimer: string;
}
export const DISCLAIMER = "Elena suggests; she does not decide and this is not legal advice. Your solicitors or conveyancer should check anything you agree.";

const SERIOUS = /\b(asbestos|structural|termite|pest|mould|mold|damp|roof|foundation|subsidence|illegal|unapproved|electrical|plumbing|safety)\b/i;

const TEMPLATES: Record<DisputeType, Template[]> = {
  inspection: [
    { label: "Credit instead of repairs", text: "Accept the proposal as a price credit at settlement, so no repairs are needed before settlement." },
    { label: "Repairs with receipts", text: "Accept the proposal if the seller has the work done by a licensed tradesperson before settlement and shares the receipts." },
    { label: "Extend the date", text: "Accept the proposal but ask for the inspection-condition date to move out by five business days so quotes can be gathered." }
  ],
  financing: [
    { label: "Short finance extension", text: "Accept a short extension of the finance date, with the lender's written status shared with the seller." },
    { label: "Keep the deposit in trust", text: "Accept the extension on the basis that the deposit stays in the solicitor's trust account and the sale carries on." },
    { label: "Share the lender's letter", text: "Accept the proposal if the buyer shares the lender's conditional approval or a written update this week." }
  ],
  repair: [
    { label: "Agree the scope in writing", text: "Accept the proposal once the repair scope and a licensed quote are agreed in writing, with a cap on cost." },
    { label: "Credit and close the item", text: "Accept the proposal as a credit, recorded as the full resolution of this item between the parties. Ask both solicitors to confirm the wording." },
    { label: "Extend the date", text: "Accept the proposal but ask for the completion date to move out so the work can finish before settlement." }
  ],
  cooling_off: [
    { label: "Confirm the dates", text: "Ask both solicitors to confirm the cooling-off start and end dates in writing, then record the agreed date in the settlement tracker." },
    { label: "Agree one date", text: "Accept the proposed end date, noting public holidays were counted, and tick the stage off once both sides confirm." }
  ]
};

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2); };
export const medianPct = median;
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function assessRisk(i: MediationInput): Risk {
  const reasons: string[] = [];
  let pts = 0;
  const gap = i.buyerSharePct !== null && i.sellerSharePct !== null ? Math.abs(i.buyerSharePct - i.sellerSharePct) : null;
  if (gap !== null && gap >= 50) { pts += 2; reasons.push(`The two sides are ${gap} points apart on who pays.`); }
  else if (gap !== null && gap >= 25) { pts += 1; reasons.push(`The two sides are ${gap} points apart on who pays.`); }
  if (i.round >= MAX_ROUNDS) { pts += 2; reasons.push("This is the last round before staff step in."); }
  else if (i.round === 2) { pts += 1; reasons.push("It has already needed a second round."); }
  if (i.type === "financing") { pts += 1; reasons.push("Finance problems are a common reason sales fall through."); }
  if (i.daysToSettlement !== null && i.daysToSettlement <= 7) { pts += 2; reasons.push("Settlement is a week or less away."); }
  else if (i.daysToSettlement !== null && i.daysToSettlement <= 14) { pts += 1; reasons.push("Settlement is two weeks or less away."); }
  if (i.daysOpen >= 3) { pts += 1; reasons.push(`It has been open ${i.daysOpen} days; it goes to staff at ${ESCALATE_AFTER_DAYS}.`); }
  if (i.settlementBlocked) { pts += 1; reasons.push("The settlement stage is marked blocked."); }
  if (SERIOUS.test(`${i.description} ${i.buyerText} ${i.sellerText}`)) { pts += 1; reasons.push("A serious defect is mentioned; a licensed report helps both sides agree on cost."); }
  const level = pts >= 4 ? "high" : pts >= 2 ? "medium" : "low";
  if (!reasons.length) reasons.push("Nothing here points to a problem yet.");
  return { level, likelyFallThrough: level === "high", reasons };
}

/** Elena's suggestion for one round. Round 1 sits between the two asks, nudged toward how similar disputes ended; later rounds sit between the latest counters. */
export function mediate(i: MediationInput): Suggestion {
  const reasoning: string[] = [];
  let share: number | null = null;
  if (i.buyerSharePct !== null && i.sellerSharePct !== null) {
    const mid = (i.buyerSharePct + i.sellerSharePct) / 2;
    const useHistory = i.round === 1 && i.history !== null && i.history.samples >= MIN_HISTORY;
    share = clamp(useHistory ? (mid + i.history!.medianSellerSharePct) / 2 : mid);
    reasoning.push(`The buyer wants the seller to cover ${i.buyerSharePct}% and the seller offers ${i.sellerSharePct}%.`);
    reasoning.push(i.round === 1 ? "Elena starts from the middle of the two positions." : "Elena starts from the middle of the two latest positions.");
    if (useHistory) reasoning.push(`Similar disputes on the platform ended with the seller covering about ${i.history!.medianSellerSharePct}% (${i.history!.samples} cases), so that nudges the middle.`);
    else if (i.round === 1) reasoning.push("There are not enough similar past disputes on the platform to learn from yet.");
  } else {
    reasoning.push("No amount is in dispute, so Elena suggests terms and dates rather than a split.");
  }
  const claim = i.claimCents, sellerPays = share !== null && claim !== null ? Math.round((claim * share) / 100) : null;
  const buyerPays = sellerPays !== null && claim !== null ? claim - sellerPays : null;
  const risk = assessRisk(i);
  const headline = share !== null
    ? `Buyer covers ${100 - share}%, seller covers ${share}% of the cost.`
    : `Meet in the middle on terms and dates (${TYPE_LABEL[i.type].toLowerCase()}).`;
  const templates = [...TEMPLATES[i.type], { label: "Accept but ask for more time", text: "Accept the proposal but ask for the completion date to move out a few days." }];
  return { round: i.round, headline, sellerSharePct: share, buyerSharePct: share === null ? null : 100 - share, sellerPaysCents: sellerPays, buyerPaysCents: buyerPays, reasoning, history: i.history, risk, templates, disclaimer: DISCLAIMER };
}

/** Whole days from `from` to `to` (rounded down, never negative). */
export const daysBetween = (from: Date, to: Date): number => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));
