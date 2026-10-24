import { dollarsToCents } from "../../../src/domain/listing-details";
import { parseSavedSearchInput } from "../../../src/domain/saved-search-service";

/**
 * Turns the saved-search form into the API body and checks it with the same rules as the server.
 * Price fields are dollars (strict: "850000", "$850,000", "650.50"); bedrooms is a whole number.
 */
export function savedSearchFormBody(fd: FormData): { body: Record<string, unknown> } | { error: string } {
  const text = (k: string) => String(fd.get(k) ?? "").trim();
  const body: Record<string, unknown> = {
    transactionType: text("transactionType"),
    useClass: text("useClass"),
    jurisdictions: text("jurisdiction") ? [text("jurisdiction")] : [],
    propertyTypes: text("propertyType") ? [text("propertyType")] : [],
    suburbs: text("suburbs").split(",").map(s => s.trim()).filter(Boolean)
  };
  for (const [field, key, label] of [["minPrice", "minPriceCents", "minimum"], ["maxPrice", "maxPriceCents", "maximum"]] as const) {
    if (text(field) === "") continue;
    const cents = dollarsToCents(text(field));
    if (cents === undefined) return { error: `Enter the ${label} price in dollars, for example 850000 or 650.50.` };
    body[key] = cents;
  }
  const beds = text("minBedrooms");
  if (beds !== "") {
    if (!/^\d{1,2}$/.test(beds)) return { error: "Minimum bedrooms must be a whole number from 0 to 20." };
    body["minBedrooms"] = Number(beds);
  }
  const checked = parseSavedSearchInput(body);
  return checked.ok ? { body } : { error: checked.message };
}
