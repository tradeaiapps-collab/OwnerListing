/**
 * The negotiation mandate: the limits the owner sets for AI-assisted negotiation on one listing (House Listing Spec,
 * section 5). Versioned and insert-only: every save is a new version. The floor price is confidential: it is sealed
 * before storage, never returned after saving and never put in an AI prompt. Pure validation; storage is in
 * src/server/mandate-db.ts.
 */
import type { NegotiationMandate } from "./offers";

/** Conditions an owner can pre-approve. A buyer's condition outside this list always goes to the owner. */
export const MANDATE_CONDITIONS = [
  { key: "finance", label: "Subject to finance" },
  { key: "building_pest", label: "Subject to building and pest inspection" },
  { key: "valuation", label: "Subject to valuation" },
  { key: "sale_of_buyer_home", label: "Subject to sale of the buyer's home" },
  { key: "strata_report", label: "Subject to strata or body corporate report" },
  { key: "solicitor_review", label: "Subject to solicitor's review of the contract" }
] as const;
export type MandateConditionKey = (typeof MANDATE_CONDITIONS)[number]["key"];
const CONDITION_KEYS: readonly string[] = MANDATE_CONDITIONS.map(c => c.key);

export const MANDATE_LIMITS = { maxRounds: 10, maxConcessionBps: 1000, minSettlementDays: 1, maxSettlementDays: 365, maxPriceCents: 100_000_000_000 } as const;
/** Auto mode stays off until Gate G3 (spec: assisted only for the first 60 days after launch). */
export const AUTO_MODE_AVAILABLE = false;

export interface QuietHours { from: string; to: string }

/** What is stored for one version, with the floor sealed. */
export interface MandateVersion {
  listingId: string;
  version: number;
  floorSealed: string;
  targetPriceCents: number;
  maxCounterRounds: number;
  maxConcessionBpsPerRound: number;
  approvedConditions: MandateConditionKey[];
  settlementMinDays: number;
  settlementMaxDays: number;
  autoModeEnabled: boolean;
  quietHours: QuietHours;
  setBy: "owner" | "agent";
  createdAt: string;
}

/** What the page and API see. The floor is only ever "set" or not. */
export type MandateView = Omit<MandateVersion, "floorSealed"> & { floorSet: true };

/** A validated save. `floorPriceCents` is absent when the owner keeps the current floor. */
export interface MandateInput {
  expectedVersion: number;
  floorPriceCents?: number;
  targetPriceCents: number;
  maxCounterRounds: number;
  maxConcessionBpsPerRound: number;
  approvedConditions: MandateConditionKey[];
  settlementMinDays: number;
  settlementMaxDays: number;
  autoModeEnabled: boolean;
  quietHours: QuietHours;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { from: "20:00", to: "08:00" };

const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

type Parsed = { ok: true; value: MandateInput } | { ok: false; code: "invalid"; message: string; fields: Record<string, string> };

/**
 * Checks a save request. `hasFloor` says whether an earlier version already holds a floor (then it may be kept).
 * Errors are per field so the form can show them next to the input.
 */
export function parseMandateInput(body: unknown, hasFloor: boolean): Parsed {
  const fields: Record<string, string> = {};
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const P = MANDATE_LIMITS;

  if (!int(b["expectedVersion"], 0, 1_000_000)) fields["expectedVersion"] = "Missing version. Reload the page.";
  const floor = b["floorPriceCents"];
  if (floor === undefined || floor === null) { if (!hasFloor) fields["floorPriceCents"] = "Set the lowest price you would accept."; }
  else if (!int(floor, 1, P.maxPriceCents)) fields["floorPriceCents"] = "Enter a whole dollar amount.";
  if (!int(b["targetPriceCents"], 1, P.maxPriceCents)) fields["targetPriceCents"] = "Enter the price you are aiming for.";
  if (int(floor, 1, P.maxPriceCents) && int(b["targetPriceCents"], 1, P.maxPriceCents) && floor > b["targetPriceCents"]) {
    fields["floorPriceCents"] = "The lowest price cannot be above the target price.";
  }
  if (!int(b["maxCounterRounds"], 0, P.maxRounds)) fields["maxCounterRounds"] = `Choose 0 to ${P.maxRounds} rounds.`;
  if (!int(b["maxConcessionBpsPerRound"], 0, P.maxConcessionBps)) fields["maxConcessionBpsPerRound"] = "Choose 0% to 10% per round.";
  const conds = b["approvedConditions"];
  if (!Array.isArray(conds) || conds.some(c => typeof c !== "string" || !CONDITION_KEYS.includes(c))) fields["approvedConditions"] = "Unknown condition.";
  const lo = b["settlementMinDays"], hi = b["settlementMaxDays"];
  if (!int(lo, P.minSettlementDays, P.maxSettlementDays)) fields["settlementMinDays"] = "Between 1 and 365 days.";
  if (!int(hi, P.minSettlementDays, P.maxSettlementDays)) fields["settlementMaxDays"] = "Between 1 and 365 days.";
  else if (int(lo, P.minSettlementDays, P.maxSettlementDays) && lo > hi) fields["settlementMaxDays"] = "Must be at least the shortest settlement.";
  if (typeof b["autoModeEnabled"] !== "boolean") fields["autoModeEnabled"] = "Choose a mode.";
  else if (b["autoModeEnabled"] && !AUTO_MODE_AVAILABLE) fields["autoModeEnabled"] = "Auto mode is not available yet. Every AI reply waits for your approval.";
  const qh = b["quietHours"] as Record<string, unknown> | undefined;
  if (!qh || typeof qh["from"] !== "string" || typeof qh["to"] !== "string" || !TIME.test(qh["from"]) || !TIME.test(qh["to"])) fields["quietHours"] = "Use times like 20:00.";

  if (Object.keys(fields).length > 0) return { ok: false, code: "invalid", message: "Check the highlighted fields.", fields };
  return {
    ok: true,
    value: {
      expectedVersion: b["expectedVersion"] as number,
      ...(int(floor, 1, P.maxPriceCents) ? { floorPriceCents: floor } : {}),
      targetPriceCents: b["targetPriceCents"] as number,
      maxCounterRounds: b["maxCounterRounds"] as number,
      maxConcessionBpsPerRound: b["maxConcessionBpsPerRound"] as number,
      approvedConditions: [...new Set(conds as MandateConditionKey[])].sort(),
      settlementMinDays: lo as number,
      settlementMaxDays: hi as number,
      autoModeEnabled: b["autoModeEnabled"] as boolean,
      quietHours: { from: qh!["from"] as string, to: qh!["to"] as string }
    }
  };
}

/** Never send the sealed floor anywhere: the view only says a floor exists. */
export function toMandateView(v: MandateVersion): MandateView {
  const { floorSealed: _sealed, ...rest } = v;
  return { ...rest, floorSet: true };
}

/** Which settings changed between two versions, in words, for the history list. The floor is named, never shown. */
export function changedFields(prev: MandateVersion | undefined, next: MandateVersion): string[] {
  if (!prev) return ["Mandate created"];
  const out: string[] = [];
  if (prev.floorSealed !== next.floorSealed) out.push("Lowest price");
  if (prev.targetPriceCents !== next.targetPriceCents) out.push("Target price");
  if (prev.maxCounterRounds !== next.maxCounterRounds) out.push("Counter rounds");
  if (prev.maxConcessionBpsPerRound !== next.maxConcessionBpsPerRound) out.push("Concession per round");
  if (prev.approvedConditions.join() !== next.approvedConditions.join()) out.push("Accepted conditions");
  if (prev.settlementMinDays !== next.settlementMinDays || prev.settlementMaxDays !== next.settlementMaxDays) out.push("Settlement window");
  if (prev.quietHours.from !== next.quietHours.from || prev.quietHours.to !== next.quietHours.to) out.push("Quiet hours");
  if (prev.autoModeEnabled !== next.autoModeEnabled) out.push("Mode");
  return out.length ? out : ["No changes"];
}

/** The policy engine's view (src/domain/offers.ts evaluateOfferAction). Needs the opened floor; server-side only. */
export function toPolicyMandate(v: MandateVersion, floorPriceCents: number): NegotiationMandate {
  return {
    listingId: v.listingId, version: v.version, floorPriceCents, targetPriceCents: v.targetPriceCents,
    maxCounterRounds: v.maxCounterRounds, maxConcessionBpsPerRound: v.maxConcessionBpsPerRound,
    autoModeEnabled: v.autoModeEnabled, approvedConditions: MANDATE_CONDITIONS.filter(c => v.approvedConditions.includes(c.key)).map(c => c.label)
  };
}

/** AAD for sealing a floor: binds the ciphertext to its listing, so it cannot be copied to another listing's mandate. */
export const floorAad = (listingId: string) => `mandate-floor:${listingId}`;
