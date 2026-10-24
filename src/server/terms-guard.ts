import { termsGateFor } from "../domain/terms";
import type { Failure } from "../domain/listing-service";

/**
 * Route guard for actions that need the current terms (offers, enquiries, offer links, new drafts).
 * Null means go ahead. Fails closed: a missing check, a lookup error or a non-true answer all refuse.
 */
export async function requireCurrentTerms(
  check: ((userId: string) => Promise<boolean>) | undefined,
  userId: string
): Promise<Failure | null> {
  try {
    return termsGateFor(check ? await check(userId) : false);
  } catch {
    return termsGateFor(false);
  }
}
