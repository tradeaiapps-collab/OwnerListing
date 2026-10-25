import type { Failure, Result } from "./listing-service";

/**
 * Counter-offer rules. Turns alternate through the offer's status: "countered" waits for the buyer, "buyer_countered"
 * waits for the owner. Only the owner ever accepts. A buyer who likes the owner's counter "agrees" to it, which hands
 * it back to the owner to accept. The AI is never an actor here.
 */
export const MAX_COUNTER_ROUNDS = 10;
export const DEFAULT_COUNTER_DAYS = 3;
export const MAX_COUNTER_DAYS = 14;

export interface CounterTerms {
  priceCents: number;
  depositCents: number;
  settlementDays: number;
  conditions: string[];
}
export interface CounterInput extends CounterTerms {
  /** How long the other side has to answer, 1 to MAX_COUNTER_DAYS days. */
  expiresInDays: number;
}

/** Offer statuses where the owner may send a counter (the buyer's terms are on the table). */
export const OWNER_COUNTER_FROM: readonly string[] = ["submitted", "under_review", "buyer_countered"];
/** The offer status where the buyer may answer (counter, agree or withdraw). */
export const BUYER_TURN = "countered";
/** Offer statuses a buyer may withdraw from. Once accepted, rejected or expired, it is closed. */
export const WITHDRAWABLE: readonly string[] = ["submitted", "under_review", "countered", "buyer_countered"];

/** Offer statuses with a counter (or a request for one) waiting on a reply, so they can run out of time. */
export const CAN_EXPIRE: readonly string[] = ["countered", "buyer_countered"];

export type Party = "owner" | "buyer";

/** Whose move it is, or null when the offer is closed. */
export function awaiting(status: string): Party | null {
  if (status === "countered") return "buyer";
  if (status === "submitted" || status === "under_review" || status === "buyer_countered") return "owner";
  return null;
}

const invalid = (message: string): Failure => ({ ok: false, code: "invalid", message });

/** Shape and range check of counter terms from a request body. Same limits as the buyer's formal offer. */
export function parseCounterInput(body: unknown): Result<CounterInput> {
  if (typeof body !== "object" || body === null) return invalid("Invalid input.");
  const b = body as Record<string, unknown>;
  const price = b["priceCents"];
  const deposit = b["depositCents"];
  const days = b["settlementDays"];
  const expires = b["expiresInDays"] ?? DEFAULT_COUNTER_DAYS;
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(deposit) || !Number.isSafeInteger(days) || !Number.isSafeInteger(expires)) {
    return invalid("Price, deposit, settlement days and reply time must be whole numbers.");
  }
  if ((price as number) <= 0) return invalid("Price must be greater than zero.");
  if ((deposit as number) < 0 || (deposit as number) > (price as number)) return invalid("Deposit must be between zero and the price.");
  if ((days as number) < 1 || (days as number) > 365) return invalid("Settlement must be 1 to 365 days.");
  if ((expires as number) < 1 || (expires as number) > MAX_COUNTER_DAYS) return invalid(`Reply time must be 1 to ${MAX_COUNTER_DAYS} days.`);
  const raw = b["conditions"] ?? [];
  if (!Array.isArray(raw) || raw.some(c => typeof c !== "string")) return invalid("Conditions: up to 10, each 1 to 200 characters.");
  const conditions = (raw as string[]).map(c => c.trim());
  if (conditions.length > 10 || conditions.some(c => c.length === 0 || c.length > 200)) return invalid("Conditions: up to 10, each 1 to 200 characters.");
  return {
    ok: true,
    value: { priceCents: price as number, depositCents: deposit as number, settlementDays: days as number, conditions, expiresInDays: expires as number }
  };
}

/** When a counter made at `nowIso` stops being answerable. */
export function counterExpiry(nowIso: string, days: number): string {
  return new Date(Date.parse(nowIso) + days * 86_400_000).toISOString();
}

/** True when the terms are the same as the ones already on the table (a counter must change something). */
export function sameTerms(a: CounterTerms, b: CounterTerms): boolean {
  return a.priceCents === b.priceCents && a.depositCents === b.depositCents && a.settlementDays === b.settlementDays &&
    a.conditions.length === b.conditions.length && a.conditions.every((c, i) => c === b.conditions[i]);
}

/** The counter id a buyer agrees to, from the request body. */
export function parseAgree(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const id = (body as Record<string, unknown>)["counterId"];
  return typeof id === "string" ? id : undefined;
}
