import { dollarsToCents, MAX_ROOMS } from "../../src/domain/listing-details";
import type { BondPathway } from "../../src/domain/publish";

export const JSON_HEADERS = { "content-type": "application/json" } as const;

/** Owner-facing labels. Record keyed by BondPathway so the compiler flags any pathway left without a label. */
export const BOND_PATHWAY_LABELS: Record<BondPathway, string> = {
  state_bond_authority: "State bond authority",
  solicitor_trust: "Solicitor's trust account",
  bank_guarantee: "Bank guarantee",
  no_bond: "No bond"
};

const ROOM_FIELDS = [["bedrooms", "Bedrooms"], ["bathrooms", "Bathrooms"], ["parking", "Parking spaces"]] as const;

export type FieldErrors = Record<string, string>;

/**
 * Turns the listing form into the API body. Blank optional fields become null, which clears them on edit.
 * The price field is dollars; the API takes whole cents. On failure `errors` maps each bad field name to its message.
 */
export function listingFormBody(fd: FormData): { body: Record<string, unknown> } | { error: string; errors: FieldErrors } {
  const body: Record<string, unknown> = {};
  const errors: FieldErrors = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && k !== "price") body[k] = v;
  body["amenities"] = fd.getAll("amenities").filter((v): v is string => typeof v === "string");
  for (const k of ["suburb", "postcode", "description"]) body[k] = String(body[k] ?? "").trim() || null;
  if (String(body["title"] ?? "").trim() === "") errors["title"] = "Enter a title for the listing.";
  if (String(body["address"] ?? "").trim() === "") errors["address"] = "Enter the street address.";
  if (body["postcode"] !== null && !/^\d{4}$/.test(String(body["postcode"]))) errors["postcode"] = "Postcode must be 4 digits, for example 4000.";
  const price = String(fd.get("price") ?? "").trim();
  if (price === "") body["priceCents"] = null;
  else {
    const cents = dollarsToCents(price);
    if (cents === undefined) errors["price"] = "Enter the price in dollars, for example 850000 or 650.50.";
    else body["priceCents"] = cents;
  }
  for (const [k, label] of ROOM_FIELDS) {
    const raw = String(body[k] ?? "").trim();
    if (raw === "") { body[k] = null; continue; }
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n > MAX_ROOMS) { errors[k] = `${label} must be a whole number from 0 to ${MAX_ROOMS}.`; continue; }
    body[k] = n;
  }
  const count = Object.keys(errors).length;
  if (count > 0) return { error: count === 1 ? "Fix the highlighted field to continue." : `Fix the ${count} highlighted fields to continue.`, errors };
  return { body };
}

/** Scrolls to and focuses the first invalid field, in form order. */
export function focusFirstError(form: HTMLFormElement, errors: FieldErrors) {
  for (const el of Array.from(form.elements)) {
    const name = (el as HTMLInputElement).name;
    if (name && errors[name] !== undefined) { (el as HTMLElement).focus(); (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" }); return; }
  }
}

/** Cents as a plain dollar amount for an input: 85000000 -> "850000", 65050 -> "650.50". */
export const centsToInput = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
