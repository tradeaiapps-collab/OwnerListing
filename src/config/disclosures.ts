import type { Jurisdiction } from "../domain/jurisdiction";
import type { UseClass } from "../domain/listing";

/**
 * Compliance-owned configuration. Required disclosures depend on the state, whether it is a sale or a rental,
 * and whether it is residential or commercial. Until a combination is configured this returns null and
 * publishing is blocked (fail closed).
 */
const REQUIRED_DISCLOSURES: Readonly<Record<string, readonly string[]>> = {};

export function getRequiredDisclosureKeys(
  j: Jurisdiction, transactionType: "sale" | "rent", useClass: UseClass
): readonly string[] | null {
  return REQUIRED_DISCLOSURES[`${j}:${transactionType}:${useClass}`] ?? null;
}
