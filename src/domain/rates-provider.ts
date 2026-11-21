import { isJurisdiction, type Jurisdiction } from "./jurisdiction";
import { MAX_RATE_CENTS, type Charge, type ListingRates, type RatePeriod } from "./listing-rates";
import { dollarsToCents } from "./listing-details";
import { splitCsvLine, MAX_IMPORT_ROWS, type ImportLineError } from "./suburb-data";

/**
 * Council and water rates per address, from a source other than the seller. The platform has no paid data feed yet, so the only
 * implementation is a table staff fill from CSV files they are licensed to use. A real provider (a council or water authority export,
 * CoreLogic, PriceFinder and similar) implements RatesProvider and is returned by getRatesProvider() in src/server/rates-provider.ts.
 */
export interface RatesRecord { state: Jurisdiction; address: string; rates: ListingRates; source: string; asAt: string }
export interface RatesProvider {
  /** Short name shown to staff and stored as the source when the provider is not a CSV table. */
  readonly name: string;
  /** Rates for one address, or null when the provider has nothing. Must not throw for "not found". */
  lookup(query: { state: Jurisdiction; address: string }): Promise<RatesRecord | null>;
}

const ABBREV: Record<string, string> = {
  st: "street", rd: "road", ave: "avenue", av: "avenue", dr: "drive", ct: "court", cres: "crescent", pl: "place", ln: "lane",
  tce: "terrace", hwy: "highway", pde: "parade", blvd: "boulevard", cl: "close", cct: "circuit", esp: "esplanade", sq: "square",
  nth: "north", sth: "south", pk: "park", unit: "unit", u: "unit"
};

/**
 * Matching key for an address: lower case, punctuation removed, street types spelled out, and a trailing state and postcode dropped,
 * so "12 Smith St, Bondi NSW 2026" and "12 smith street bondi" match. Unit numbers stay ("3/12" becomes "3 12").
 */
export function addressKey(address: string): string {
  const words = address.toLowerCase().replace(/[.,;#]/g, " ").replace(/[/\\-]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  while (words.length > 1 && (/^\d{4}$/.test(words[words.length - 1]!) || isJurisdiction(words[words.length - 1]!.toUpperCase()))) words.pop();
  return words.map(w => ABBREV[w] ?? w).join(" ");
}

export const RATES_COLUMNS = ["address", "state", "council_amount", "council_period", "water_amount", "water_period", "water_usage_billed_separately"] as const;

const periodOf = (v: string): RatePeriod | null => { const t = v.trim().toLowerCase(); return t === "quarter" || t === "quarterly" ? "quarter" : t === "year" || t === "yearly" || t === "annual" ? "year" : null; };

function charge(amount: string, period: string, name: string): { ok: true; value: Charge | undefined } | { ok: false; message: string } {
  if (amount === "" && period === "") return { ok: true, value: undefined };
  const cents = dollarsToCents(amount);
  if (cents === undefined || cents < 1 || cents > MAX_RATE_CENTS) return { ok: false, message: `${name} amount must be dollars like 520.40.` };
  const p = periodOf(period);
  if (!p) return { ok: false, message: `${name} period must be quarter or year.` };
  return { ok: true, value: { cents, period: p } };
}

/** Parses a rates CSV (header row required, any column order; address and state are required). All or nothing: up to 20 line errors. */
export function parseRatesCsv(csv: string): { ok: true; rows: { state: Jurisdiction; address: string; rates: ListingRates }[] } | { ok: false; errors: ImportLineError[] } {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).map((l, i) => ({ l, n: i + 1 })).filter(x => x.l.trim() !== "");
  if (lines.length < 2) return { ok: false, errors: [{ line: 0, message: "The file needs a header row and at least one address." }] };
  if (lines.length - 1 > MAX_IMPORT_ROWS) return { ok: false, errors: [{ line: 0, message: `A file can hold up to ${MAX_IMPORT_ROWS} addresses.` }] };
  const header = splitCsvLine(lines[0]!.l)?.map(h => h.toLowerCase());
  if (!header) return { ok: false, errors: [{ line: lines[0]!.n, message: "The header row is not valid CSV." }] };
  const unknown = header.filter(h => !(RATES_COLUMNS as readonly string[]).includes(h));
  if (unknown.length) return { ok: false, errors: [{ line: lines[0]!.n, message: `Unknown column: ${unknown.slice(0, 3).join(", ")}. Columns are ${RATES_COLUMNS.join(", ")}.` }] };
  if (!header.includes("address") || !header.includes("state")) return { ok: false, errors: [{ line: lines[0]!.n, message: "The columns address and state are required." }] };
  const errors: ImportLineError[] = [], rows: { state: Jurisdiction; address: string; rates: ListingRates }[] = [], seen = new Set<string>();
  for (const { l, n } of lines.slice(1)) {
    const cells = splitCsvLine(l);
    if (!cells || cells.length !== header.length) { errors.push({ line: n, message: "The line does not match the header (check quotes and commas)." }); continue; }
    const get = (k: string) => (cells[header.indexOf(k)] ?? "").trim();
    const state = get("state").toUpperCase();
    const address = get("address");
    if (!isJurisdiction(state)) { errors.push({ line: n, message: "State must be NSW, VIC, QLD, WA, SA, TAS, ACT or NT." }); continue; }
    const key = addressKey(address);
    if (key.length < 5 || address.length > 200) { errors.push({ line: n, message: "Give the full street address." }); continue; }
    if (seen.has(`${state}|${key}`)) { errors.push({ line: n, message: "This address is in the file twice." }); continue; }
    const council = charge(get("council_amount"), get("council_period"), "Council");
    if (!council.ok) { errors.push({ line: n, message: council.message }); continue; }
    const water = charge(get("water_amount"), get("water_period"), "Water");
    if (!water.ok) { errors.push({ line: n, message: water.message }); continue; }
    if (!council.value && !water.value) { errors.push({ line: n, message: "Give a council or a water amount." }); continue; }
    const u = get("water_usage_billed_separately").toLowerCase();
    if (u !== "" && !["yes", "no", "true", "false"].includes(u)) { errors.push({ line: n, message: "Water usage must be yes or no." }); continue; }
    seen.add(`${state}|${key}`);
    const rates: ListingRates = {};
    if (council.value) rates.council = council.value;
    if (water.value) rates.water = water.value;
    if (u !== "") rates.waterUsageBilledSeparately = u === "yes" || u === "true";
    rows.push({ state, address, rates });
  }
  return errors.length > 0 ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, rows };
}

export const SOURCE_KIND_LABEL: Record<string, string> = { owner: "Stated by the seller", staff: "Entered by our staff", import: "From imported council and water data", provider: "From a rates data provider" };
