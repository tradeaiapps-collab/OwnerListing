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
    if (!/^\d{1,2}$/.test(beds)) return { error: "Minimum bedrooms must be a whole number from 1 to 20." };
    body["minBedrooms"] = Number(beds);
  }
  for (const [field, key, label] of [["minBathrooms", "minBathrooms", "bathrooms"], ["minParking", "minParking", "parking"]] as const) {
    const v = text(field);
    if (v === "") continue;
    if (!/^\d{1,2}$/.test(v)) return { error: `Minimum ${label} must be a whole number from 0 to 20.` };
    body[key] = Number(v);
  }
  const amenities = fd.getAll("amenities").filter((v): v is string => typeof v === "string");
  if (amenities.length > 0) body["amenities"] = amenities;
  const checked = parseSavedSearchInput(body);
  return checked.ok ? { body } : { error: checked.message };
}

/** Non-blocking hints for the saved-search form, shown as the buyer edits. */
export function savedSearchHints(fd: FormData): string[] {
  const text = (k: string) => String(fd.get(k) ?? "").trim();
  const hints: string[] = [];
  if (text("jurisdiction") && text("suburbs") === "") hints.push("No suburbs chosen, so this search covers the whole state. Add suburbs to narrow it.");
  if (text("minBathrooms") === "0" || text("minParking") === "0") hints.push("0 bathrooms or parking means no minimum, so it is left out of the saved search.");
  return hints;
}
