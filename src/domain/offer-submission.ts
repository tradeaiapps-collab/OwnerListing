import type { Failure, Result } from "./listing-service";

/** The buyer's offer form as sent to the API. The buyer is NOT in here: it comes from the single-use link. */
export interface OfferSubmission {
  /** The raw link token from the chat link. Only its hash is looked up. */
  token: string;
  priceCents: number;
  conditions: string[];
  settlementDays: number;
  depositCents: number;
  confirmedFinal: boolean;
}

const invalid = (message: string): Failure => ({ ok: false, code: "invalid", message });

/** Shape check only. Amounts, settlement and conditions are range-checked by validateFormalOffer. */
export function parseOfferSubmission(body: unknown): Result<OfferSubmission> {
  if (typeof body !== "object" || body === null) return invalid("Invalid input.");
  const b = body as Record<string, unknown>;
  const token = b["token"];
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return invalid("This offer link is not valid.");
  const price = b["priceCents"];
  const days = b["settlementDays"];
  const deposit = b["depositCents"];
  if (!Number.isSafeInteger(price) || !Number.isSafeInteger(days) || !Number.isSafeInteger(deposit)) {
    return invalid("Price, settlement days and deposit must be whole numbers.");
  }
  const conditions = b["conditions"] ?? [];
  if (!Array.isArray(conditions) || conditions.length > 10 || conditions.some(c => typeof c !== "string")) {
    return invalid("Conditions: up to 10, each 1 to 200 characters.");
  }
  if (b["confirmedFinal"] !== true) return invalid("The buyer must confirm this is their formal, final offer.");
  return {
    ok: true,
    value: {
      token,
      priceCents: price as number,
      conditions: (conditions as string[]).map(c => c.trim()),
      settlementDays: days as number,
      depositCents: deposit as number,
      confirmedFinal: true
    }
  };
}
