import {
  adjust, estimatePrice, groupOf, MIN_COMPARABLES, roundStep, roundTo, type Comparable, type PriceEstimate, type Subject
} from "./price-guidance";
import { formatPrice } from "./listing-details";
import type { SuburbMetrics } from "./suburb-data";

/**
 * Elena's asking-price suggestion for the owner (approve screen and edit page). Numbers come from rules over data we really hold:
 * sold results on the platform, other published listings (asking prices), the suburb figures staff loaded, land size, and a licensed
 * provider when one is plugged in. We have no external sales feed today, so with little data the answer is "not enough data", never a
 * made-up number. It is a guide only: never a valuation, never public, and it never changes the price (only the owner does).
 */

export const SUGGESTION_MODEL_VERSION = "price-suggestion-v1";
export const SUGGESTION_DISCLAIMER =
  "A guide only. This is not a valuation, appraisal, or financial or legal advice, and it may be wrong. It is shown only to you and never to buyers. " +
  "You decide the price; Elena never changes it. For a formal valuation, ask a licensed valuer.";
export const INSUFFICIENT_MESSAGE = "Elena does not have enough data to suggest a price for this property yet.";

export type Confidence = "low" | "medium" | "high";
export type BasisKind = "provider_valuation" | "sold_comparables" | "asking_comparables" | "suburb_median";

/**
 * Plug-in point for a licensed data source (PriceFinder, CoreLogic, an open dataset, a bank AVM). Both methods are optional and must never
 * throw (return nothing when unavailable). `sales` rows join the platform's own sold results; `valuation` wins when it returns a range.
 */
export interface PriceProvider {
  id: string;
  label: string;
  sales?(subject: Subject, now: string): Promise<Comparable[]>;
  valuation?(subject: Subject, now: string): Promise<ProviderValuation | undefined>;
}
export interface ProviderValuation { lowCents: number; midCents: number; highCents: number; confidence: Confidence; note?: string }

export interface SuggestionSubject extends Subject {
  /** Land size in square metres, when known. */
  landAreaSqm?: number;
  /** The owner's current price, if set. Only compared against the range, never changed. */
  currentPriceCents?: number;
  amenities?: readonly string[];
}
/** A published listing on the platform other than the subject. Its price is an ASKING price, not a sale. */
export interface AskingListing extends Comparable { areaSqm?: number }

export interface SuggestionInput {
  subject: SuggestionSubject;
  /** Sold or leased results (platform events plus any provider rows). */
  sales: readonly Comparable[];
  asking: readonly AskingListing[];
  suburb?: { metrics: SuburbMetrics; source: string; asAt: string };
  valuation?: { provider: string; label: string; value: ProviderValuation };
  /** Count of inspection or pest reports the owner has uploaded (their findings are not priced in). */
  inspectionReports?: number;
  now: string;
}

export interface EvidenceRow {
  kind: "sold" | "asking";
  label: string;
  suburb: string;
  date: string;
  priceCents: number;
  bedrooms?: number;
  bathrooms?: number;
  areaSqm?: number;
  distanceKm?: number;
}

export type PriceSuggestion =
  | {
      state: "ready"; basis: BasisKind; basisLabel: string; lowCents: number; midCents: number; highCents: number; confidence: Confidence;
      summary: string; evidence: EvidenceRow[]; steps: string[]; notPricedIn: string[]; position?: { relation: "inside" | "above" | "below"; text: string };
      source: string; modelVersion: string; disclaimer: string;
    }
  | { state: "insufficient"; message: string; missing: string[]; modelVersion: string; disclaimer: string };

const LAND_ELASTICITY = 0.2;
/** Land-size scaling for houses and land: price changes by (subject area / comparable area)^0.2, limited to +/-15%. Tunable. */
export function landFactor(subjectSqm: number | undefined, compSqm: number | undefined): number {
  if (!subjectSqm || !compSqm || subjectSqm <= 0 || compSqm <= 0) return 1;
  return Math.min(1.15, Math.max(0.85, Math.pow(subjectSqm / compSqm, LAND_ELASTICITY)));
}

const confWord = (n: number): Confidence => (n >= 0.7 ? "high" : n >= 0.5 ? "medium" : "low");
const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const lower = (a: Confidence, b: Confidence): Confidence => (rank[a] <= rank[b] ? a : b);

function evidenceOf(kind: "sold" | "asking", rows: readonly { c: Comparable; original: number }[]): EvidenceRow[] {
  return rows.slice(0, 8).map(({ c, original }) => ({
    kind, label: (c.label ?? c.suburb).slice(0, 120), suburb: c.suburb, date: c.date, priceCents: original,
    ...(c.bedrooms !== undefined ? { bedrooms: c.bedrooms } : {}), ...(c.bathrooms !== undefined ? { bathrooms: c.bathrooms } : {}),
    ...(c.areaSqm !== undefined ? { areaSqm: c.areaSqm } : {}), ...(c.distanceKm !== undefined ? { distanceKm: c.distanceKm } : {})
  }));
}

/** Range from the comparables, after land-size scaling. Evidence shows the original prices. */
function fromComparables(subject: SuggestionSubject, comps: readonly Comparable[], now: string, kind: "sold" | "asking"):
  { est: PriceEstimate; evidence: EvidenceRow[]; landAdjusted: boolean } | undefined {
  const useLand = (groupOf(subject.propertyType) === "house" || groupOf(subject.propertyType) === "land") && subject.landAreaSqm !== undefined;
  const originals = new Map(comps.map(c => [c.id, c.priceCents]));
  let landAdjusted = false;
  const scaled = comps.map(c => {
    const f = useLand ? landFactor(subject.landAreaSqm, c.areaSqm) : 1;
    if (f !== 1) landAdjusted = true;
    return f === 1 ? c : { ...c, priceCents: Math.round(c.priceCents * f) };
  });
  const est = estimatePrice(subject, scaled, now);
  if (!est) return undefined;
  const rows = est.comparables.map(u => ({ c: u as Comparable, original: originals.get(u.id) ?? u.priceCents }));
  return { est, evidence: evidenceOf(kind, rows), landAdjusted };
}

/** Counts how many comparables could be used at all (same type group, same area, a price), even if too few for a range. */
function usableCount(subject: Subject, comps: readonly Comparable[]): number {
  const g = groupOf(subject.propertyType);
  return comps.filter(c => c.transactionType === subject.transactionType && groupOf(c.propertyType) === g && c.priceCents > 0 &&
    ((subject.suburb && c.suburb.trim().toLowerCase() === subject.suburb.trim().toLowerCase()) || (subject.postcode && c.postcode === subject.postcode))).length;
}

function position(subject: SuggestionSubject, low: number, high: number): { relation: "inside" | "above" | "below"; text: string } | undefined {
  const p = subject.currentPriceCents;
  if (!p) return undefined;
  const tx = subject.transactionType;
  if (p < low) return { relation: "below", text: `Your current price ${formatPrice(p, tx)} is below this range.` };
  if (p > high) return { relation: "above", text: `Your current price ${formatPrice(p, tx)} is above this range.` };
  return { relation: "inside", text: `Your current price ${formatPrice(p, tx)} is inside this range.` };
}

function notPricedIn(i: SuggestionInput): string[] {
  const out = ["Condition, renovations, views, street and the quality of the photos are not priced in."];
  if (i.inspectionReports && i.inspectionReports > 0) out.push("Your inspection and pest reports are not priced in. Defects they list can lower what buyers will pay.");
  if (i.subject.amenities?.length) out.push(`Features such as ${i.subject.amenities.slice(0, 4).join(", ").replace(/_/g, " ")} are not priced in.`);
  return out;
}

/** Pure and deterministic. */
export function buildPriceSuggestion(i: SuggestionInput): PriceSuggestion {
  const s = i.subject, tx = s.transactionType;
  const common = { modelVersion: SUGGESTION_MODEL_VERSION, disclaimer: SUGGESTION_DISCLAIMER };
  const ready = (p: Omit<Extract<PriceSuggestion, { state: "ready" }>, "state" | "modelVersion" | "disclaimer" | "notPricedIn" | "position">) => ({
    state: "ready" as const, ...p, notPricedIn: notPricedIn(i), ...(position(s, p.lowCents, p.highCents) ? { position: position(s, p.lowCents, p.highCents)! } : {}), ...common
  });

  if (i.valuation) {
    const v = i.valuation.value;
    return ready({
      basis: "provider_valuation", basisLabel: `Automated valuation from ${i.valuation.label}`, lowCents: v.lowCents, midCents: v.midCents, highCents: v.highCents,
      confidence: v.confidence, evidence: [], source: i.valuation.provider,
      summary: `${i.valuation.label} estimates ${formatPrice(v.lowCents, tx)} to ${formatPrice(v.highCents, tx)}.${v.note ? ` ${v.note}` : ""}`,
      steps: [`The range comes from ${i.valuation.label}. Elena has not changed it.`]
    });
  }

  const sold = fromComparables(s, i.sales, i.now, "sold");
  if (sold) {
    const e = sold.est;
    const conf = e.comparables.length < MIN_COMPARABLES ? "low" : confWord(e.confidence);
    const steps = [...e.basis];
    if (sold.landAdjusted) steps.push("Results were scaled for land size, a little only, because land size moves price slowly.");
    return ready({
      basis: "sold_comparables", basisLabel: `${e.comparables.length} sold ${tx === "rent" ? "leases" : "results"} of similar properties`,
      lowCents: e.lowCents, midCents: e.midCents, highCents: e.highCents, confidence: conf, evidence: sold.evidence, steps, source: "sold_comparables",
      summary: `Based on ${e.comparables.length} ${tx === "rent" ? "recent leases" : "recent sales"} nearby, similar properties ${tx === "rent" ? "rent for" : "sold for"} about ${formatPrice(e.lowCents, tx)} to ${formatPrice(e.highCents, tx)}.`
    });
  }

  const ask = fromComparables(s, i.asking, i.now, "asking");
  if (ask) {
    const e = ask.est;
    return ready({
      basis: "asking_comparables", basisLabel: `${e.comparables.length} other listings on the platform (asking prices, not sales)`,
      lowCents: e.lowCents, midCents: e.midCents, highCents: e.highCents, confidence: "low", evidence: ask.evidence,
      steps: [...e.basis, "These are what other owners are asking, not what buyers paid. Sold prices are often lower than asking prices, so treat this range as a ceiling-style guide.",
        ...(ask.landAdjusted ? ["Results were scaled a little for land size."] : [])],
      source: "asking_comparables",
      summary: `Other similar listings nearby are asking about ${formatPrice(e.lowCents, tx)} to ${formatPrice(e.highCents, tx)}. We have no recent sold results here, so confidence is low.`
    });
  }

  // Thin data: one or two comparables, or the suburb median alone. Always low confidence, always shown with what it rests on.
  const g = groupOf(s.propertyType);
  const medianKey = tx === "rent" ? "medianWeeklyRent" : g === "house" ? "medianHousePrice" : g === "unit" || g === "attached" ? "medianUnitPrice" : undefined;
  const median = medianKey ? i.suburb?.metrics[medianKey] : undefined;
  const salesIds = new Set(i.sales.map(c => c.id));
  const few = [...i.sales, ...i.asking].filter(c => c.transactionType === tx && groupOf(c.propertyType) === g && c.priceCents > 0 &&
    ((s.suburb && c.suburb.trim().toLowerCase() === s.suburb.trim().toLowerCase()) || (s.postcode && c.postcode === s.postcode)));
  if (few.length > 0 && few.length < MIN_COMPARABLES) {
    const adj = few.map(c => adjust(s, c)).sort((a, b) => a - b);
    const mid = adj[Math.floor(adj.length / 2)]!;
    const step = roundStep(tx, mid);
    const low = roundTo(mid * 0.85, step), high = roundTo(mid * 1.15, step);
    return ready({
      basis: "asking_comparables", basisLabel: `Only ${few.length} comparable ${few.length === 1 ? "listing" : "listings"} on the platform`,
      lowCents: low, midCents: roundTo(mid, step), highCents: high, confidence: "low",
      evidence: [...evidenceOf("sold", few.filter(c => salesIds.has(c.id)).map(c => ({ c, original: c.priceCents }))),
        ...evidenceOf("asking", few.filter(c => !salesIds.has(c.id)).map(c => ({ c, original: c.priceCents })))], source: "few_comparables",
      steps: [`Only ${few.length} comparable ${few.length === 1 ? "result" : "results"} found, so the range is simply 15% either side of ${few.length === 1 ? "it" : "their middle"}.`],
      summary: `Very little data: ${few.length} similar ${few.length === 1 ? "property" : "properties"} nearby. Treat ${formatPrice(low, tx)} to ${formatPrice(high, tx)} as a rough guess only.`
    });
  }
  if (median && i.suburb) {
    const step = roundStep(tx, median);
    const low = roundTo(median * 0.8, step), high = roundTo(median * 1.2, step);
    return ready({
      basis: "suburb_median", basisLabel: `Suburb median (${i.suburb.source}, as at ${i.suburb.asAt})`, lowCents: low, midCents: roundTo(median, step), highCents: high,
      confidence: "low", evidence: [], source: "suburb_median",
      steps: [`No comparable results are on the platform for this area. The range is 20% either side of the suburb median of ${formatPrice(median, tx)}, and does not reflect this property's size or features.`],
      summary: `Only suburb figures are available, so this is a very broad guide: ${formatPrice(low, tx)} to ${formatPrice(high, tx)}.`
    });
  }

  const missing: string[] = [];
  if (!s.suburb && !s.postcode) missing.push("The listing has no suburb or postcode yet.");
  if (usableCount(s, i.sales) === 0) missing.push("No sold results for similar properties on the platform in this area.");
  if (usableCount(s, i.asking) === 0) missing.push("No other similar listings on the platform in this area.");
  if (!median) missing.push("No suburb figures loaded for this suburb.");
  missing.push("No licensed sales-data provider is connected.");
  return { state: "insufficient", message: INSUFFICIENT_MESSAGE, missing, ...common };
}
