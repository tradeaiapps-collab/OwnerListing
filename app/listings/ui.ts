import { priceInputToCents, MAX_ROOMS } from "../../src/domain/listing-details";
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

/**
 * Turns the listing form into the API body. Blank optional fields become null, which clears them on edit.
 * The price field is dollars; the API takes whole cents.
 */
export function listingFormBody(fd: FormData): { body: Record<string, unknown> } | { error: string } {
  const body: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && k !== "price") body[k] = v;
  if (fd.getAll("allowFlagged").length > 0) body["allowFlagged"] = true; else delete body["allowFlagged"];
  body["amenities"] = fd.getAll("amenities").filter((v): v is string => typeof v === "string");
  for (const k of ["suburb", "postcode", "description"]) body[k] = String(body[k] ?? "").trim() || null;
  const price = String(fd.get("price") ?? "").trim();
  if (price === "") body["priceCents"] = null;
  else {
    const cents = priceInputToCents(price);
    if (cents === undefined) return { error: "Enter the price in dollars, for example 850000, 850k or 650.50. Cents are optional." };
    body["priceCents"] = cents;
  }
  for (const [k, label] of ROOM_FIELDS) {
    const raw = String(body[k] ?? "").trim();
    if (raw === "") { body[k] = null; continue; }
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n > MAX_ROOMS) return { error: `${label} must be a whole number from 0 to ${MAX_ROOMS}.` };
    body[k] = n;
  }
  return { body };
}

/** Cents as a plain dollar amount for an input: 85000000 -> "850000", 65050 -> "650.50". */
export const centsToInput = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));
