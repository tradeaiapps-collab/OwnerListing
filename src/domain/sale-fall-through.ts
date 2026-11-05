// Sale fell through: pure rules for what happens to a deposit held in trust when an accepted offer will not complete.
// The platform never holds money and never decides: it proposes an outcome from the state rules, the other side agrees or disputes,
// and an agreed outcome becomes a pre-filled request in the existing two-person refund / release flow (deposit-escrow.ts).
import { MIN_REASON, reasonOk } from "./staff-admin";
import { MAX_CENTS, type Plan, type Result } from "./deposit-escrow";

export const REASONS = ["cooling_off", "finance_condition", "building_pest_condition", "other_condition", "buyer_default", "seller_default", "mutual_termination"] as const;
export type FallThroughReason = (typeof REASONS)[number];
export type Party = "buyer" | "owner";
export type CaseStatus = "proposed" | "disputed" | "agreed" | "resolved" | "withdrawn";
export type ResolutionSource = "parties" | "agreement" | "court_order" | "sale_continues";

export const REASON_LABEL: Record<FallThroughReason, string> = {
  cooling_off: "Cooling-off period", finance_condition: "Finance condition not met", building_pest_condition: "Building or pest condition not met",
  other_condition: "Another condition not met", buyer_default: "Buyer default", seller_default: "Seller default", mutual_termination: "Both sides agree to end the contract"
};
export const STATUS_LABEL: Record<CaseStatus, string> = {
  proposed: "Waiting for the other side", disputed: "Disputed: deposit frozen", agreed: "Agreed: refund in progress", resolved: "Finished", withdrawn: "Withdrawn"
};

export const isReason = (v: unknown): v is FallThroughReason => typeof v === "string" && (REASONS as readonly string[]).includes(v);
/** Statuses in which the deposit is frozen: no ordinary receipt, release, refund, approval or cancel until the case ends. */
export const FROZEN: readonly CaseStatus[] = ["proposed", "disputed", "agreed"];
export const isFrozen = (cases: readonly { status: string }[]) => cases.some(c => (FROZEN as readonly string[]).includes(c.status));

// ---------- state rules ----------

/** Values written from memory of the statutes. NOT confirmed by counsel: shown to people as an estimate and listed in docs/COUNSEL_QUESTIONS.md section 4. */
export const RULES_VERSION = "2026-11-05-draft";
export const RULES_CONFIRMED = false;

export interface StateRule {
  /** Business days after the contract in which the buyer may withdraw; null where the state has no cooling-off right. */
  coolingOffBusinessDays: number | null;
  /** Penalty the buyer forfeits, in basis points of the price (25 = 0.25%); null when unknown. */
  penaltyBps: number | null;
  /** Floor for the penalty, in cents (Victoria: the greater of 0.2% and $100). */
  penaltyMinCents?: number;
}
export const STATE_RULES: Record<string, StateRule> = {
  QLD: { coolingOffBusinessDays: 5, penaltyBps: 25 },
  NSW: { coolingOffBusinessDays: 5, penaltyBps: 25 },
  ACT: { coolingOffBusinessDays: 5, penaltyBps: 25 },
  VIC: { coolingOffBusinessDays: 3, penaltyBps: 20, penaltyMinCents: 10_000 },
  SA: { coolingOffBusinessDays: 2, penaltyBps: null },
  NT: { coolingOffBusinessDays: 4, penaltyBps: null },
  WA: { coolingOffBusinessDays: null, penaltyBps: null },
  TAS: { coolingOffBusinessDays: null, penaltyBps: null }
};

const DAY = 86_400_000;
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
/** Weekdays after `from`, up to and including `to`. Public holidays are not excluded (counsel to confirm). 0 when `to` is not after `from`. */
export function businessDaysAfter(from: string, to: string): number {
  let n = 0;
  for (let t = dayMs(from) + DAY; t <= dayMs(to); t += DAY) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

// ---------- the proposed outcome ----------

export interface OutcomeInput {
  reason: FallThroughReason; party: Party; state: string; priceCents: number; heldCents: number;
  /** The date the offer was accepted (the contract date for cooling-off) and the date this is raised. */
  acceptedOn: string; raisedOn: string;
}
export interface Outcome {
  refundCents: number; releaseCents: number; penaltyCents: number; penaltyUnconfirmed: boolean; basis: string; rulesVersion: string; rulesConfirmed: boolean;
}
const bad = (error: string): Result<never> => ({ ok: false, error });
const aud = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Who may raise which reason: only the buyer has a cooling-off right or can call a seller default, only the owner can call a buyer default. */
export function partyMayRaise(party: Party, reason: FallThroughReason): boolean {
  if (reason === "cooling_off" || reason === "seller_default") return party === "buyer";
  if (reason === "buyer_default") return party === "owner";
  return true;
}
export const reasonsFor = (party: Party): FallThroughReason[] => REASONS.filter(r => partyMayRaise(party, r));

export function proposeOutcome(i: OutcomeInput): Result<Outcome> {
  if (!partyMayRaise(i.party, i.reason)) return bad(i.party === "buyer" ? "Only the owner can say the buyer defaulted." : i.reason === "cooling_off" ? "Only the buyer can use the cooling-off period." : "Only the buyer can say the seller defaulted.");
  const held = i.heldCents;
  const base = { rulesVersion: RULES_VERSION, rulesConfirmed: RULES_CONFIRMED };
  const full = (basis: string): Result<Outcome> => ({ ok: true, value: { refundCents: held, releaseCents: 0, penaltyCents: 0, penaltyUnconfirmed: false, basis, ...base } });
  switch (i.reason) {
    case "finance_condition": case "building_pest_condition": case "other_condition":
      return full("A condition in the contract was not met, so the buyer gets the whole deposit back. Staff check the condition and its dates before paying out.");
    case "seller_default": return full("The seller did not meet the contract, so the buyer gets the whole deposit back.");
    case "mutual_termination": return full("Both sides end the contract. The whole deposit goes back to the buyer unless you dispute this and agree something else with staff.");
    case "buyer_default":
      return { ok: true, value: { refundCents: 0, releaseCents: held, penaltyCents: 0, penaltyUnconfirmed: false, basis: "The buyer did not meet the contract, so the seller keeps the deposit held in trust.", ...base } };
    case "cooling_off": {
      const rule = STATE_RULES[i.state];
      if (!rule) return bad(`We do not have cooling-off rules for ${i.state || "this state"}. Choose another reason or ask us for help.`);
      if (rule.coolingOffBusinessDays === null) return bad(`${i.state} has no statutory cooling-off period. If both sides agree to end the sale, choose “${REASON_LABEL.mutual_termination}”.`);
      const used = businessDaysAfter(i.acceptedOn, i.raisedOn), limit = rule.coolingOffBusinessDays;
      if (used > limit) return bad(`The ${limit} business day cooling-off period in ${i.state} ended ${used - limit} business day${used - limit === 1 ? "" : "s"} ago.`);
      let penalty = 0;
      if (rule.penaltyBps !== null) {
        penalty = Math.round((i.priceCents * rule.penaltyBps) / 10_000);
        if (rule.penaltyMinCents !== undefined) penalty = Math.max(penalty, rule.penaltyMinCents);
        penalty = Math.min(penalty, held);
      }
      const unconfirmed = rule.penaltyBps === null;
      const pct = rule.penaltyBps === null ? "" : `${rule.penaltyBps / 100}% of the price${rule.penaltyMinCents ? ` or ${aud(rule.penaltyMinCents)}, whichever is greater` : ""}`;
      const basis = `Cooling-off in ${i.state}: ${limit} business days from the contract, used ${used}. ` + (unconfirmed
        ? "The penalty for this state is not yet confirmed, so none is taken in this estimate; staff check it before any payment."
        : `The buyer forfeits ${pct} (${aud(penalty)}) to the seller and the rest (${aud(held - penalty)}) is refunded.`);
      return { ok: true, value: { refundCents: held - penalty, releaseCents: penalty, penaltyCents: penalty, penaltyUnconfirmed: unconfirmed, basis, ...base } };
    }
  }
}

// ---------- input parsing ----------

export type FallThroughAction =
  | { action: "preview"; reason: FallThroughReason }
  | { action: "raise"; reason: FallThroughReason; note: string | null }
  | { action: "respond"; decision: "agree" | "dispute"; note: string | null }
  | { action: "withdraw" };

export const MIN_DISPUTE = 10;
export function parseFallThrough(body: Record<string, unknown> | null): Result<FallThroughAction> {
  if (!body) return bad("Send the action.");
  const note = typeof body["note"] === "string" && body["note"].trim() ? body["note"].trim() : null;
  if (note && note.length > 1000) return bad("Keep the note to 1,000 characters.");
  switch (body["action"]) {
    case "preview": case "raise": {
      if (!isReason(body["reason"])) return bad("Choose why the sale fell through.");
      return body["action"] === "preview" ? { ok: true, value: { action: "preview", reason: body["reason"] } } : { ok: true, value: { action: "raise", reason: body["reason"], note } };
    }
    case "respond": {
      const d = body["decision"];
      if (d !== "agree" && d !== "dispute") return bad("Choose agree or dispute.");
      if (d === "dispute" && (note?.length ?? 0) < MIN_DISPUTE) return bad(`Tell us why you dispute it, in at least ${MIN_DISPUTE} characters.`);
      return { ok: true, value: { action: "respond", decision: d, note } };
    }
    case "withdraw": return { ok: true, value: { action: "withdraw" } };
    default: return bad("Unknown action.");
  }
}

export interface ResolutionInput { source: ResolutionSource; reference: string | null; refundCents: number; releaseCents: number; reason: string }
const cents0 = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS;
/** Staff record how a dispute ended: an agreement between the parties, a court order, or that the sale goes ahead after all. */
export function parseResolution(body: Record<string, unknown>, heldCents: number): Result<ResolutionInput> {
  const source = body["source"];
  if (source !== "agreement" && source !== "court_order" && source !== "sale_continues") return bad("Choose agreement, court order or sale continues.");
  if (!reasonOk(body["reason"])) return bad(`A reason of at least ${MIN_REASON} characters is required.`);
  const reference = typeof body["reference"] === "string" && body["reference"].trim() ? body["reference"].trim() : null;
  if (reference && reference.length > 200) return bad("The reference is at most 200 characters.");
  if (source === "court_order" && !reference) return bad("Enter the court order reference.");
  if (source === "sale_continues") return { ok: true, value: { source, reference, refundCents: 0, releaseCents: 0, reason: (body["reason"] as string).trim() } };
  const refund = body["refundCents"] ?? 0, release = body["releaseCents"] ?? 0;
  if (!cents0(refund) || !cents0(release)) return bad("Enter the refund and release amounts in whole cents.");
  if (refund + release > heldCents) return bad("The amounts add up to more than is held in trust.");
  return { ok: true, value: { source, reference, refundCents: refund, releaseCents: release, reason: (body["reason"] as string).trim() } };
}

// ---------- rules for each step ----------

const yes: Plan = { allow: true };
const no = (status: number, error: string): Plan => ({ allow: false, status, error });

export interface CaseLike { status: CaseStatus; raisedByParty: Party; refundCents: number; releaseCents: number }

export function planRespond(c: Pick<CaseLike, "status" | "raisedByParty">, party: Party): Plan {
  if (c.status !== "proposed") return no(409, "This has already been answered.");
  if (c.raisedByParty === party) return no(403, "The other side has to answer this, not you.");
  return yes;
}
export function planWithdraw(c: Pick<CaseLike, "status" | "raisedByParty">, party: Party): Plan {
  if (c.raisedByParty !== party) return no(403, "Only the person who raised this can withdraw it.");
  if (c.status !== "proposed") return no(409, "It can only be withdrawn while the other side has not answered.");
  return yes;
}
export const planStaffResolve = (c: Pick<CaseLike, "status">): Plan => (c.status === "disputed" ? yes : no(409, "Only a disputed case needs a recorded resolution."));

export type PayoutLine = { kind: "refund" | "release"; amountCents: number };
/** The next payout to request from an agreed case: the refund to the buyer first, then the release to the seller. Null when both are requested. */
export function nextPayout(c: CaseLike, linked: readonly { kind: "refund" | "release"; status: string }[]): PayoutLine | null {
  const live = (k: "refund" | "release") => linked.some(r => r.kind === k && r.status !== "rejected");
  if (c.refundCents > 0 && !live("refund")) return { kind: "refund", amountCents: c.refundCents };
  if (c.releaseCents > 0 && !live("release")) return { kind: "release", amountCents: c.releaseCents };
  return null;
}
export function planCasePayout(c: CaseLike, linked: readonly { kind: "refund" | "release"; status: string }[], anyPending: boolean, heldCents: number): Result<PayoutLine> {
  if (c.status !== "agreed") return bad("Only an agreed outcome can be paid out from here.");
  if (anyPending) return bad("A payment is already waiting for approval.");
  const next = nextPayout(c, linked);
  if (!next) return bad("Every payment for this outcome has been requested.");
  if (next.amountCents > heldCents) return bad("Less is held in trust than this payment. Check the ledger first.");
  return { ok: true, value: next };
}
/** The case is finished once every line it agreed has an approved payment. */
export function allPaid(c: CaseLike, linked: readonly { kind: "refund" | "release"; status: string }[]): boolean {
  const paid = (k: "refund" | "release") => linked.some(r => r.kind === k && r.status === "approved");
  return (c.refundCents === 0 || paid("refund")) && (c.releaseCents === 0 || paid("release"));
}
