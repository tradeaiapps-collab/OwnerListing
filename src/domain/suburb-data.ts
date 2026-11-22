import { formatAud } from "./listing-details";
import { isJurisdiction, type Jurisdiction } from "./jurisdiction";

/**
 * Suburb data feed: staff import a CSV of suburb figures from a source they are licensed to use (ABS, a state valuer, a data vendor),
 * and buyers see a small "Suburb snapshot" on a listing in that suburb. Figures are labelled with their source and date. Nothing here
 * is a valuation, feeds an offer, or reads a licensed third-party feed by itself: a person loads the file and names the source.
 * A file is all-or-nothing: if any row is bad, nothing is saved and the bad lines are listed.
 */

export const MAX_IMPORT_ROWS = 2000;
export const MAX_IMPORT_BYTES = 400_000;
export const MAX_SOURCE_LENGTH = 120;

export type MetricKind = "money" | "weekly_money" | "count" | "percent" | "years";
export interface MetricDef { key: string; column: string; label: string; kind: MetricKind; min: number; max: number }

/** The fixed set of figures. `column` is the CSV header and the JSON key stored; money is entered in dollars and stored as cents. */
export const METRICS: readonly MetricDef[] = [
  { key: "medianHousePrice", column: "median_house_price", label: "Median house price", kind: "money", min: 1, max: 100_000_000 },
  { key: "medianUnitPrice", column: "median_unit_price", label: "Median unit price", kind: "money", min: 1, max: 100_000_000 },
  { key: "medianWeeklyRent", column: "median_weekly_rent", label: "Median weekly rent", kind: "weekly_money", min: 1, max: 100_000 },
  { key: "medianHouseholdIncome", column: "median_household_income_weekly", label: "Median household income", kind: "weekly_money", min: 1, max: 1_000_000 },
  { key: "population", column: "population", label: "Population", kind: "count", min: 0, max: 5_000_000 },
  { key: "medianAge", column: "median_age", label: "Median age", kind: "years", min: 0, max: 120 },
  { key: "ownerOccupiedPct", column: "owner_occupied_pct", label: "Homes lived in by their owner", kind: "percent", min: 0, max: 100 },
  { key: "rentalVacancyPct", column: "rental_vacancy_pct", label: "Rental vacancy rate", kind: "percent", min: 0, max: 100 }
];
export type SuburbMetrics = Partial<Record<(typeof METRICS)[number]["key"], number>>;

export interface SuburbRow { state: Jurisdiction; suburb: string; postcode: string | null; metrics: SuburbMetrics }
export interface ImportLineError { line: number; message: string }

/** Lower-cased, single-spaced suburb name used for matching ("St  Kilda" matches "st kilda"). */
export const suburbKey = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Splits one CSV line, supporting double-quoted fields and "" escapes. No multi-line fields. */
export function splitCsvLine(line: string): string[] | null {
  const out: string[] = [];
  let cur = "", quoted = false, i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"' && cur === "") { quoted = true; i++; continue; }
    if (ch === ",") { out.push(cur.trim()); cur = ""; i++; continue; }
    if (ch === '"') return null;
    cur += ch; i++;
  }
  if (quoted) return null;
  out.push(cur.trim());
  return out;
}

const NUM_RE = /^\d{1,12}(\.\d{1,4})?$/;

function parseMetric(def: MetricDef, raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = raw.replace(/[$,%\s]/g, "");
  if (!NUM_RE.test(text)) return { ok: false, message: `${def.column} must be a plain number.` };
  const n = Number(text);
  if (n < def.min || n > def.max) return { ok: false, message: `${def.column} must be between ${def.min} and ${def.max}.` };
  if (def.kind === "count" && !Number.isInteger(n)) return { ok: false, message: `${def.column} must be a whole number.` };
  if (def.kind === "money" || def.kind === "weekly_money") {
    const cents = Math.round(n * 100);
    return { ok: true, value: cents };
  }
  return { ok: true, value: n };
}

/**
 * Parses a CSV with the header row `state,suburb,postcode` plus any of the metric columns. Blank cells mean "not provided" (the
 * suburb's existing value is replaced by the file, so a blank clears it). Returns every bad line, not just the first.
 */
export function parseSuburbCsv(csv: string): { ok: true; rows: SuburbRow[] } | { ok: false; errors: ImportLineError[] } {
  if (csv.length > MAX_IMPORT_BYTES) return { ok: false, errors: [{ line: 0, message: "The file is too large. Split it into files under 400 KB." }] };
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length === 0) return { ok: false, errors: [{ line: 0, message: "The file is empty." }] };
  const header = splitCsvLine(lines[0]!)?.map(h => h.toLowerCase());
  if (!header) return { ok: false, errors: [{ line: 1, message: "The header row has unbalanced quotes." }] };
  const known = new Set(["state", "suburb", "postcode", ...METRICS.map(m => m.column)]);
  const unknown = header.filter(h => !known.has(h));
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (unknown.length > 0) return { ok: false, errors: [{ line: 1, message: `Unknown column: ${unknown.slice(0, 3).join(", ")}.` }] };
  if (dup) return { ok: false, errors: [{ line: 1, message: `Column ${dup} appears twice.` }] };
  for (const need of ["state", "suburb"]) if (!header.includes(need)) return { ok: false, errors: [{ line: 1, message: `The header needs a ${need} column.` }] };
  if (header.length === 2 || !header.some(h => METRICS.some(m => m.column === h))) return { ok: false, errors: [{ line: 1, message: "Add at least one figure column, for example median_house_price." }] };
  if (lines.length - 1 > MAX_IMPORT_ROWS) return { ok: false, errors: [{ line: 0, message: `A file can hold at most ${MAX_IMPORT_ROWS} suburbs.` }] };
  if (lines.length === 1) return { ok: false, errors: [{ line: 0, message: "The file has a header but no suburbs." }] };

  const rows: SuburbRow[] = [], errors: ImportLineError[] = [], seen = new Set<string>();
  const col = (cells: string[], name: string) => { const i = header.indexOf(name); return i < 0 ? "" : (cells[i] ?? ""); };
  for (let n = 1; n < lines.length; n++) {
    const lineNo = n + 1;
    if (lines[n]!.trim() === "") { errors.push({ line: lineNo, message: "Blank line." }); continue; }
    const cells = splitCsvLine(lines[n]!);
    if (!cells) { errors.push({ line: lineNo, message: "Unbalanced quotes." }); continue; }
    if (cells.length !== header.length) { errors.push({ line: lineNo, message: `Expected ${header.length} columns, found ${cells.length}.` }); continue; }
    const state = col(cells, "state").toUpperCase(), suburb = col(cells, "suburb").replace(/\s+/g, " ").trim(), postcode = col(cells, "postcode");
    if (!isJurisdiction(state)) { errors.push({ line: lineNo, message: `State must be one of NSW, VIC, QLD, WA, SA, TAS, ACT, NT (found "${state}").` }); continue; }
    if (suburb.length < 1 || suburb.length > 80) { errors.push({ line: lineNo, message: "Suburb must be 1 to 80 characters." }); continue; }
    if (postcode !== "" && !/^\d{4}$/.test(postcode)) { errors.push({ line: lineNo, message: "Postcode must be 4 digits." }); continue; }
    const key = `${state}:${suburbKey(suburb)}`;
    if (seen.has(key)) { errors.push({ line: lineNo, message: `${suburb} ${state} appears more than once.` }); continue; }
    seen.add(key);
    const metrics: SuburbMetrics = {};
    let bad = false;
    for (const def of METRICS) {
      const raw = col(cells, def.column);
      if (raw === "") continue;
      const r = parseMetric(def, raw);
      if (!r.ok) { errors.push({ line: lineNo, message: r.message }); bad = true; break; }
      metrics[def.key] = r.value;
    }
    if (bad) continue;
    if (Object.keys(metrics).length === 0) { errors.push({ line: lineNo, message: "No figures on this line." }); continue; }
    rows.push({ state, suburb, postcode: postcode || null, metrics });
  }
  return errors.length > 0 ? { ok: false, errors: errors.slice(0, 20) } : { ok: true, rows };
}

/** Source label and as-at date for an import. `today` is YYYY-MM-DD; the date cannot be in the future or older than 10 years. */
export function parseImportMeta(source: unknown, asAt: unknown, today: string): { ok: true; source: string; asAt: string } | { ok: false; message: string } {
  if (typeof source !== "string" || source.trim().length < 3 || source.trim().length > MAX_SOURCE_LENGTH) return { ok: false, message: `Name the source of the figures (3 to ${MAX_SOURCE_LENGTH} characters), for example "ABS Census 2021".` };
  if (typeof asAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asAt) || new Date(`${asAt}T00:00:00Z`).toISOString().slice(0, 10) !== asAt) return { ok: false, message: "The figures date must be a real date like 2026-06-30." };
  if (asAt > today) return { ok: false, message: "The figures date cannot be in the future." };
  const limit = new Date(`${today}T00:00:00Z`); limit.setUTCFullYear(limit.getUTCFullYear() - 10);
  if (asAt < limit.toISOString().slice(0, 10)) return { ok: false, message: "The figures are more than 10 years old." };
  return { ok: true, source: source.trim(), asAt };
}

export interface SuburbFact { label: string; value: string }
export interface SuburbView { suburb: string; state: Jurisdiction; postcode: string | null; source: string; asAt: string; facts: SuburbFact[] }

const fmtNum = (n: number) => new Intl.NumberFormat("en-AU").format(n);
const fmtPct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

export function formatMetric(def: MetricDef, v: number): string {
  switch (def.kind) {
    case "money": return formatAud(v);
    case "weekly_money": return `${formatAud(v)} per week`;
    case "count": return fmtNum(v);
    case "percent": return fmtPct(v);
    case "years": return `${v} years`;
  }
}

/** What buyers see: only figures that exist, in a fixed order. Null when the suburb has none. */
export function toSuburbView(p: { suburb: string; state: Jurisdiction; postcode: string | null; metrics: SuburbMetrics; source: string; asAt: string }): SuburbView | null {
  const facts: SuburbFact[] = [];
  for (const def of METRICS) { const v = p.metrics[def.key]; if (typeof v === "number") facts.push({ label: def.label, value: formatMetric(def, v) }); }
  return facts.length === 0 ? null : { suburb: p.suburb, state: p.state, postcode: p.postcode, source: p.source, asAt: p.asAt, facts };
}
