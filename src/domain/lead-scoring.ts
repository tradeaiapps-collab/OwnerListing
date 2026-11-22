import type { Failure, Result } from "./listing-service";

/**
 * Lead scoring rules (pure). A lead's score blends three parts, each 0-100:
 *  - engagement: offers, buyer messages and recency (computed in agent-workspace.ts, unchanged),
 *  - fit: how well the listing matches the buyer's active saved searches (price, bedrooms, suburb, property type),
 *  - follow-up: urgency from the agent's follow-up date (overdue first) and how long the lead has been idle.
 * Staff set the blend and the hot/warm thresholds; an agent can override one lead's score with a reason.
 * A part with no data (no saved search) is left out and the other weights are scaled up, so missing data never lowers a score.
 */
export interface ScoringWeights { engagement: number; fit: number; followUp: number }
export interface ScoringConfig { hotMin: number; warmMin: number; weights: ScoringWeights }
export const DEFAULT_SCORING: ScoringConfig = { hotMin: 70, warmMin: 40, weights: { engagement: 60, fit: 25, followUp: 15 } };
export const MAX_OVERRIDE_REASON = 300;

const deny = (message: string): Failure => ({ ok: false, code: "invalid", message });
const whole = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);

/** Staff input. Weights are whole percentages that add up to 100; warm must sit below hot. */
export function parseScoringConfig(body: unknown): Result<ScoringConfig> {
  const o = (body ?? {}) as Record<string, unknown>;
  const w = (o["weights"] ?? {}) as Record<string, unknown>;
  const hotMin = whole(o["hotMin"], 2, 100), warmMin = whole(o["warmMin"], 1, 99);
  if (hotMin === undefined || warmMin === undefined) return deny("Thresholds must be whole numbers: hot 2-100 and warm 1-99.");
  if (warmMin >= hotMin) return deny("The warm threshold must be lower than the hot threshold.");
  const engagement = whole(w["engagement"], 0, 100), fit = whole(w["fit"], 0, 100), followUp = whole(w["followUp"], 0, 100);
  if (engagement === undefined || fit === undefined || followUp === undefined) return deny("Each weight must be a whole number from 0 to 100.");
  if (engagement + fit + followUp !== 100) return deny("The three weights must add up to 100.");
  return { ok: true, value: { hotMin, warmMin, weights: { engagement, fit, followUp } } };
}

export const bandFor = (score: number, cfg: ScoringConfig): "hot" | "warm" | "cold" => (score >= cfg.hotMin ? "hot" : score >= cfg.warmMin ? "warm" : "cold");

export interface SearchCriteria { minPriceCents?: number; maxPriceCents?: number; minBedrooms?: number; suburbs?: string[]; propertyTypes?: string[]; transactionType?: string }
export interface FitFacts { priceCents?: number; bedrooms?: number; suburb?: string; propertyType?: string; transactionType?: string; searches: SearchCriteria[] }

/** Share of a search's stated criteria the listing meets; the best search wins. Undefined when the buyer has no usable saved search. */
export function fitPercent(f: FitFacts | undefined): { percent: number; reasons: string[] } | undefined {
  if (!f) return undefined;
  let best: { percent: number; reasons: string[] } | undefined;
  for (const s of f.searches) {
    const checks: [string, boolean][] = [];
    if (s.transactionType && f.transactionType) checks.push(["deal type", s.transactionType === f.transactionType]);
    if (s.suburbs?.length && f.suburb) checks.push(["suburb", s.suburbs.some(x => x.toLowerCase() === f.suburb!.toLowerCase())]);
    if (s.propertyTypes?.length && f.propertyType) checks.push(["property type", s.propertyTypes.includes(f.propertyType)]);
    if (s.minBedrooms !== undefined && f.bedrooms !== undefined) checks.push(["bedrooms", f.bedrooms >= s.minBedrooms]);
    if ((s.minPriceCents !== undefined || s.maxPriceCents !== undefined) && f.priceCents !== undefined) {
      checks.push(["price", (s.minPriceCents === undefined || f.priceCents >= s.minPriceCents) && (s.maxPriceCents === undefined || f.priceCents <= s.maxPriceCents)]);
    }
    if (checks.length === 0) continue;
    const hit = checks.filter(c => c[1]);
    const percent = Math.round((hit.length / checks.length) * 100);
    if (!best || percent > best.percent) best = { percent, reasons: checks.map(([n, ok]) => `${ok ? "Matches" : "Outside"} saved-search ${n}`) };
  }
  return best;
}

const DAY = 86_400_000;
/** 0-100: overdue follow-ups rank highest, then dates coming up, then idle leads with none set. Closed leads score 0. */
export function followUpUrgency(stage: string, followUpAt: string | undefined, idleDays: number, today: string): { value: number; reason?: string } {
  if (stage === "won" || stage === "lost") return { value: 0 };
  if (followUpAt) {
    if (followUpAt < today) return { value: 100, reason: "Follow-up is overdue" };
    const days = Math.round((Date.parse(followUpAt) - Date.parse(today)) / DAY);
    if (days <= 2) return { value: 75, reason: "Follow-up due within 2 days" };
    return { value: 35, reason: "Follow-up scheduled" };
  }
  return idleDays > 14 ? { value: 60, reason: "No follow-up set and the lead is going quiet" } : { value: 25 };
}

/** Weighted blend of the parts that have data. */
export function blend(parts: { engagement: number; fit?: number | undefined; followUp: number }, cfg: ScoringConfig): number {
  const items: [number, number][] = [[parts.engagement, cfg.weights.engagement], [parts.followUp, cfg.weights.followUp]];
  if (parts.fit !== undefined) items.push([parts.fit, cfg.weights.fit]);
  const total = items.reduce((s, [, w]) => s + w, 0);
  if (total === 0) return parts.engagement;
  return Math.max(0, Math.min(100, Math.round(items.reduce((s, [v, w]) => s + v * w, 0) / total)));
}

export function parseOverride(body: unknown): Result<{ score: number; reason: string }> {
  const o = (body ?? {}) as Record<string, unknown>;
  const score = whole(o["score"], 0, 100);
  const reason = typeof o["reason"] === "string" ? o["reason"].trim() : "";
  if (score === undefined) return deny("Score must be a whole number from 0 to 100.");
  if (reason.length < 3) return deny("Say why you are changing the score (at least 3 characters).");
  if (reason.length > MAX_OVERRIDE_REASON) return deny(`Keep the reason under ${MAX_OVERRIDE_REASON} characters.`);
  return { ok: true, value: { score, reason } };
}

/** Saved-search criteria arrive as stored JSON; keep only the fields scoring uses and drop anything malformed. */
export function parseFitSearches(raw: unknown): SearchCriteria[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : undefined);
  return raw.slice(0, 10).flatMap((c): SearchCriteria[] => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    const out: SearchCriteria = {};
    const min = num(o["minPriceCents"]), max = num(o["maxPriceCents"]), beds = num(o["minBedrooms"]), sub = strs(o["suburbs"]), types = strs(o["propertyTypes"]);
    if (min !== undefined) out.minPriceCents = min;
    if (max !== undefined) out.maxPriceCents = max;
    if (beds !== undefined) out.minBedrooms = beds;
    if (sub?.length) out.suburbs = sub;
    if (types?.length) out.propertyTypes = types;
    if (typeof o["transactionType"] === "string") out.transactionType = o["transactionType"];
    return [out];
  });
}
