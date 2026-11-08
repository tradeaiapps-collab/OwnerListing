import { formatPrice } from "./listing-details";
import { groupOf, monthsBetween, near, roundStep, roundTo, type Comparable, type Subject } from "./price-guidance";
import { daysAtPrice, STANDARD_DAYS, type ComparableSales, type PriceDaysModel, type SoldRow, type Unavailable } from "./seller-insights";

/**
 * Buyer-facing property valuation: where the asking price sits against the middle of recent comparable sales (last 90 days).
 * Pure and deterministic; it never invents a figure and gives "unavailable" when there are too few sales. Advisory only: it is not a
 * licensed valuation or appraisal. Condition and age are not recorded on a listing yet, so no adjustment is made for them.
 */

export const VALUATION_NOTE =
  "Guide only, worked out from recent sales we can see. It is not a licensed valuation or appraisal, and it does not allow for the condition or age of the property. Ask a licensed valuer before you buy.";
/** Fair range is the middle of recent sales plus or minus this share. */
export const FAIR_RANGE = 0.1;
/** Under 90% of the middle is underpriced; over 110% is overpriced; above 105% but within the range is a slight premium. */
export const UNDERPRICED_BELOW = 0.9;
export const OVERPRICED_ABOVE = 1.1;
export const SLIGHT_PREMIUM_ABOVE = 1.05;
export const MIN_COMPS_FLOOR = 3;
export const MIN_COMPS_CEILING = 50;
export const MAX_TABLE_ROWS = 8;
export const MIN_RENT_COMPS = 3;

export interface ValuationSettings { enabled: boolean; minComps: number; highConfidenceComps: number; showRange: boolean }
export const DEFAULT_VALUATION_SETTINGS: ValuationSettings = { enabled: false, minComps: 8, highConfidenceComps: 12, showRange: true };

export type PriceBand = "underpriced" | "fair" | "slight_premium" | "overpriced";
export type Tone = "green" | "yellow" | "red" | "blue";
export const BAND_LABEL: Record<PriceBand, string> = { underpriced: "Underpriced", fair: "Fairly priced", slight_premium: "Slight premium", overpriced: "Overpriced" };
/** Underpriced reads as good news for a buyer (blue, so it is not confused with "fair"); a slight premium is a warning. */
export const BAND_TONE: Record<PriceBand, Tone> = { underpriced: "blue", fair: "green", slight_premium: "yellow", overpriced: "red" };
export type Confidence = "high" | "medium";

export interface RenovationItem { key: string; label: string; costCents: number; valueAddCents: number }
export interface Renovation { items: RenovationItem[]; totalCostCents: number; totalValueAddCents: number; note: string }
export interface RentalYield { medianWeeklyRentCents: number; sample: number; grossYieldPercent: number; note: string }

/** Fixed lookup, indicative only (AUD cents). Cost is a typical spend; value add is a typical uplift. Not a quote. */
const UPGRADES: { key: string; label: string; costCents: number; valueAddCents: number; groups: readonly string[]; hasAmenity?: string }[] = [
  { key: "kitchen", label: "Modern kitchen", costCents: 4_000_000, valueAddCents: 5_500_000, groups: ["house", "attached", "unit"] },
  { key: "bathroom", label: "Bathroom update", costCents: 2_500_000, valueAddCents: 3_200_000, groups: ["house", "attached", "unit"] },
  { key: "deck", label: "Deck or outdoor area", costCents: 1_500_000, valueAddCents: 2_000_000, groups: ["house", "attached"], hasAmenity: "balcony" },
  { key: "landscaping", label: "Landscaping", costCents: 1_000_000, valueAddCents: 1_400_000, groups: ["house", "attached"], hasAmenity: "garden" },
  { key: "air_conditioning", label: "Air conditioning", costCents: 700_000, valueAddCents: 800_000, groups: ["house", "attached", "unit"], hasAmenity: "air_conditioning" },
  { key: "solar", label: "Solar panels", costCents: 800_000, valueAddCents: 900_000, groups: ["house", "attached"], hasAmenity: "solar" }
];
/** Total value add is held to this share of the middle price, so a long list never promises an unlikely uplift. */
const MAX_UPLIFT = 0.25;

export function renovationPotential(propertyType: string, amenities: readonly string[], medianCents: number): Renovation | undefined {
  const g = groupOf(propertyType);
  const items = UPGRADES.filter(u => u.groups.includes(g) && !(u.hasAmenity && amenities.includes(u.hasAmenity)))
    .map(({ key, label, costCents, valueAddCents }): RenovationItem => ({ key, label, costCents, valueAddCents }));
  if (items.length === 0) return undefined;
  const totalCostCents = items.reduce((t, i) => t + i.costCents, 0);
  const totalValueAddCents = Math.min(items.reduce((t, i) => t + i.valueAddCents, 0), Math.round(medianCents * MAX_UPLIFT));
  return { items, totalCostCents, totalValueAddCents, note: "Typical costs and uplifts from a fixed table. Your quotes and the market will differ." };
}

/** Gross yield from recent rentals of similar properties; needs three. Never a guess: undefined when there are too few. */
export function rentalYield(s: Subject, all: readonly Comparable[], askingCents: number, now: string): RentalYield | undefined {
  const rents = all.filter(c => c.transactionType === "rent" && c.priceCents > 0 && groupOf(c.propertyType) === groupOf(s.propertyType) && near(s, c) &&
    monthsBetween(c.date, now) >= 0 && monthsBetween(c.date, now) <= 6).map(c => c.priceCents).sort((a, b) => a - b);
  if (rents.length < MIN_RENT_COMPS || askingCents <= 0) return undefined;
  const m = rents.length >> 1;
  const med = rents.length % 2 ? rents[m]! : Math.round((rents[m - 1]! + rents[m]!) / 2);
  return {
    medianWeeklyRentCents: med, sample: rents.length, grossYieldPercent: Math.round(((med * 52) / askingCents) * 1000) / 10,
    note: "Gross yield: a year of typical rent over the asking price, before rates, insurance and repairs."
  };
}

export interface Valuation {
  state: "ready"; band: PriceBand; label: string; tone: Tone; confidence: Confidence; basedOnSales: number;
  askingCents: number; medianCents: number; lowCents: number; highCents: number; /** Asking against the middle, in percent (+3 = 3% above). */ differencePercent: number;
  summary: string; saleSpeed?: string | undefined; comparables: SoldRow[]; renovation?: Renovation | undefined; rental?: RentalYield | undefined; showRange: boolean; note: string;
}

const pct = (from: number, to: number) => Math.round(((to - from) / from) * 1000) / 10;
const money = (c: number) => formatPrice(c, "sale");
const step = (c: number) => roundStep("sale", c);
const round = (c: number) => roundTo(c, step(c));

export function bandFor(askingCents: number, medianCents: number): PriceBand {
  const r = askingCents / medianCents;
  return r < UNDERPRICED_BELOW ? "underpriced" : r > OVERPRICED_ABOVE ? "overpriced" : r > SLIGHT_PREMIUM_ABOVE ? "slight_premium" : "fair";
}

export interface ValuationInput {
  askingCents: number | undefined; propertyType: string; amenities?: readonly string[] | undefined;
  comps: ComparableSales | Unavailable; priceDays?: PriceDaysModel | Unavailable | undefined; rental?: RentalYield | undefined; settings: ValuationSettings;
}

export function valuate(i: ValuationInput): Valuation | Unavailable {
  const none = (message: string): Unavailable => ({ state: "unavailable", message });
  if (i.askingCents === undefined || i.askingCents <= 0) return none("This listing has no asking price, so it cannot be compared with recent sales.");
  if (i.comps.state !== "ready") return none("There are not enough recent sales of similar properties to value this listing.");
  const c = i.comps;
  if (c.count < Math.max(MIN_COMPS_FLOOR, i.settings.minComps)) return none("There are not enough recent sales of similar properties to value this listing.");
  const spread = c.medianCents > 0 ? (c.p75Cents - c.p25Cents) / c.medianCents : 1;
  const confidence: Confidence = c.count >= i.settings.highConfidenceComps && spread <= 0.3 ? "high" : "medium";
  const band = bandFor(i.askingCents, c.medianCents);
  const diff = pct(c.medianCents, i.askingCents);
  const lowCents = round(c.medianCents * (1 - FAIR_RANGE)), highCents = round(c.medianCents * (1 + FAIR_RANGE));
  const where = Math.abs(diff) < 0.5 ? "at the middle of recent sales" : `${Math.abs(diff)}% ${diff > 0 ? "above" : "below"} the middle of recent sales`;
  let saleSpeed: string | undefined;
  if (i.priceDays?.state === "ready") {
    const days = daysAtPrice(i.priceDays, i.askingCents);
    saleSpeed = band === "overpriced" || band === "slight_premium"
      ? `Similar sales suggest a home at this price could take about ${days} days to sell${days > STANDARD_DAYS ? ", slower than most" : ""}.`
      : `Similar sales suggest a home at this price could take about ${days} days to sell.`;
  }
  const reno = renovationPotential(i.propertyType, i.amenities ?? [], c.medianCents);
  return {
    state: "ready", band, label: BAND_LABEL[band], tone: BAND_TONE[band], confidence, basedOnSales: c.count,
    askingCents: i.askingCents, medianCents: c.medianCents, lowCents, highCents, differencePercent: diff,
    summary: `The asking price of ${money(i.askingCents)} is ${where} (${money(c.medianCents)}, from ${c.count} sales in the last 90 days).`,
    saleSpeed, comparables: c.rows.slice(0, MAX_TABLE_ROWS), renovation: reno, rental: i.rental, showRange: i.settings.showRange, note: VALUATION_NOTE
  };
}

/** The valuation shows when the site switch is on and this listing has not been turned off. The site switch is the master switch. */
export const valuationVisible = (settings: Pick<ValuationSettings, "enabled">, override?: { enabled: boolean }): boolean =>
  settings.enabled && override?.enabled !== false;

/** Settings from a staff request: whole numbers in range, booleans as booleans. */
export function parseValuationSettings(body: Record<string, unknown>, current: ValuationSettings): { ok: true; value: ValuationSettings } | { ok: false; error: string } {
  const int = (k: string, cur: number, lo: number, hi: number) => {
    const v = body[k];
    if (v === undefined) return cur;
    return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
  };
  const bool = (k: string, cur: boolean) => (body[k] === undefined ? cur : typeof body[k] === "boolean" ? (body[k] as boolean) : null);
  const enabled = bool("enabled", current.enabled), showRange = bool("showRange", current.showRange);
  const minComps = int("minComps", current.minComps, MIN_COMPS_FLOOR, MIN_COMPS_CEILING), high = int("highConfidenceComps", current.highConfidenceComps, MIN_COMPS_FLOOR, 100);
  if (enabled === null || showRange === null) return { ok: false, error: "enabled and showRange must be true or false." };
  if (minComps === null) return { ok: false, error: `The minimum number of sales must be a whole number from ${MIN_COMPS_FLOOR} to ${MIN_COMPS_CEILING}.` };
  if (high === null) return { ok: false, error: `The high-confidence number of sales must be a whole number from ${MIN_COMPS_FLOOR} to 100.` };
  if (high < minComps) return { ok: false, error: "The high-confidence number of sales cannot be below the minimum." };
  return { ok: true, value: { enabled, minComps, highConfidenceComps: high, showRange } };
}

export function parseOverride(body: Record<string, unknown>): { ok: true; enabled: boolean | null; reason: string } | { ok: false; error: string } {
  const e = body["enabled"];
  if (e !== true && e !== false && e !== null) return { ok: false, error: "enabled must be true, false or null (follow the site setting)." };
  const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
  if (e !== null && (reason.length < 2 || reason.length > 500)) return { ok: false, error: "Give a reason of 2 to 500 characters." };
  return { ok: true, enabled: e, reason };
}
