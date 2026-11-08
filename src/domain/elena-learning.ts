import { redact } from "./ai-learning";

/**
 * Elena's learning loop, as pure functions. It is statistics, not magic: what Elena suggested, what the person did with it, and how the
 * deal ended. From that it measures what works, learns how each person tends to act, and PROPOSES settings (suggestion weights, regional
 * variants). Guard rails: nothing is proposed under MIN_SAMPLE results, every weight stays within MAX_SHIFT of neutral, and staff activate
 * every version. It never changes the safety rules (floor price, no auto-accept, wording filter); those sit outside the learned config.
 */

export const FEATURES = ["negotiation_coach", "enquiry_reply", "offer_response", "mediation", "message_moderation", "lead_scoring", "pricing", "listing_optimization", "inspection_responder", "valuation", "other"] as const;
export type Feature = typeof FEATURES[number];
export type FeedbackAction = "accepted" | "rejected" | "modified" | "ignored";

export const MIN_SAMPLE = 30;
export const MIN_GROUP = 8;
export const SHRINK = 40;
export const MAX_SHIFT = 0.5;
export const CAPTURE_TARGET = 0.8;
export const REGION_GAP = 0.15;

export interface SuggestionFact {
  id: string;
  feature: Feature;
  type: string;
  userRole: string;
  region?: string | undefined;
  userId?: string | undefined;
  consent: boolean;
  arm?: string | undefined;
  experimentKey?: string | undefined;
  context: Readonly<Record<string, string | number | boolean>>;
  createdAt: string;
  /** Latest recorded reaction, if any. */
  action?: FeedbackAction | undefined;
  helpful?: "yes" | "no" | "partial" | undefined;
  rating?: number | undefined;
  responseSeconds?: number | undefined;
  /** How the deal ended, when the suggestion belongs to an offer that settled or fell through. */
  dealOutcome?: "settled" | "fell_through" | undefined;
  /** Days from acceptance to settlement, when the deal settled and the days are known. */
  dealDays?: number | undefined;
}

/** How much a reaction counts as a success. A modified suggestion helped, but less than an untouched one. */
export const ACTION_SCORE: Record<FeedbackAction, number> = { accepted: 1, modified: 0.6, ignored: 0.15, rejected: 0 };

/** Success blends the person's reaction (60%) with how the deal ended (40%) when both are known. */
export function successScore(f: SuggestionFact): number | undefined {
  if (f.action === undefined && f.dealOutcome === undefined) return undefined;
  const a = f.action === undefined ? undefined : ACTION_SCORE[f.action];
  const d = f.dealOutcome === undefined ? undefined : f.dealOutcome === "settled" ? 1 : 0;
  if (a === undefined) return d;
  if (d === undefined) return a;
  return 0.6 * a + 0.4 * d;
}

/** Keeps only coded facts (numbers, booleans, short tokens). Free text, emails and phone numbers never enter the learning tables. */
export function sanitiseContext(input: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" && /^[a-z0-9_\-.]{1,40}$/i.test(v)) out[k] = v;
  }
  return out;
}

export const redactText = (t: string): string => redact(t).slice(0, 5000);

/** Wilson lower bound of a rate: ranks a 9/10 group below a 90/100 group, so small samples cannot top the table. */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

export interface GroupStat { key: string; n: number; reacted: number; accepted: number; acceptanceRate: number; meanSuccess: number | undefined; lowerBound: number }

export type Dimension = "feature" | "type" | "region" | "role" | "featureType";
const keyOf = (f: SuggestionFact, d: Dimension): string =>
  d === "feature" ? f.feature : d === "type" ? f.type : d === "region" ? f.region ?? "unknown" : d === "role" ? f.userRole : `${f.feature}/${f.type}`;

/** Acceptance by feature, type, region or role. Acceptance counts accepted and modified suggestions among those a person reacted to. */
export function acceptanceBy(facts: readonly SuggestionFact[], dim: Dimension): GroupStat[] {
  const groups = new Map<string, SuggestionFact[]>();
  for (const f of facts) groups.set(keyOf(f, dim), [...(groups.get(keyOf(f, dim)) ?? []), f]);
  return [...groups.entries()].map(([key, xs]) => {
    const reacted = xs.filter(x => x.action !== undefined);
    const accepted = reacted.filter(x => x.action === "accepted" || x.action === "modified").length;
    const scores = xs.map(successScore).filter((s): s is number => s !== undefined);
    return {
      key, n: xs.length, reacted: reacted.length, accepted,
      acceptanceRate: reacted.length === 0 ? 0 : accepted / reacted.length,
      meanSuccess: scores.length === 0 ? undefined : scores.reduce((a, b) => a + b, 0) / scores.length,
      lowerBound: wilsonLower(accepted, reacted.length)
    };
  }).sort((a, b) => b.lowerBound - a.lowerBound || a.key.localeCompare(b.key));
}

/* ---------- what each person does ---------- */

export interface UserPattern {
  sampleSize: number;
  acceptRate: number;
  modifyRate: number;
  rejectRate: number;
  medianResponseSeconds: number | undefined;
  /** How quickly they act on suggestions. */
  pace: "fast" | "steady" | "slow" | "unknown";
  /** accepts_as_is: takes suggestions untouched; editor: rewrites them; selective: rejects often; balanced: none stands out. */
  style: "accepts_as_is" | "editor" | "selective" | "balanced" | "unknown";
  /** Share of suggestions rated risky ('risk' context = high) that they accepted, a rough read of risk appetite. */
  riskTolerance: "high" | "medium" | "low" | "unknown";
  preferredTypes: string[];
  /** Mean rating they gave Elena, when they rated. */
  meanRating: number | undefined;
}

export const MIN_USER_SAMPLE = 5;

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
};

/** One person's pattern. Only consenting people's own suggestions count; with fewer than MIN_USER_SAMPLE reactions the pattern says "unknown". */
export function buildUserPattern(facts: readonly SuggestionFact[]): UserPattern {
  const own = facts.filter(f => f.consent && f.action !== undefined);
  const n = own.length;
  const share = (a: FeedbackAction) => (n === 0 ? 0 : own.filter(f => f.action === a).length / n);
  const med = median(own.map(f => f.responseSeconds).filter((s): s is number => s !== undefined));
  const risky = own.filter(f => f.context["risk"] === "high");
  const riskAccept = risky.length < 3 ? undefined : risky.filter(f => f.action === "accepted" || f.action === "modified").length / risky.length;
  const ratings = own.map(f => f.rating).filter((r): r is number => r !== undefined);
  const byType = acceptanceBy(own, "type").filter(g => g.accepted > 0).slice(0, 3).map(g => g.key);
  const known = n >= MIN_USER_SAMPLE;
  const accept = share("accepted"), modify = share("modified"), reject = share("rejected");
  return {
    sampleSize: n, acceptRate: accept, modifyRate: modify, rejectRate: reject, medianResponseSeconds: med,
    pace: !known || med === undefined ? "unknown" : med <= 600 ? "fast" : med <= 86_400 ? "steady" : "slow",
    style: !known ? "unknown" : modify >= 0.4 ? "editor" : accept >= 0.6 ? "accepts_as_is" : reject >= 0.4 ? "selective" : "balanced",
    riskTolerance: riskAccept === undefined ? "unknown" : riskAccept >= 0.6 ? "high" : riskAccept >= 0.3 ? "medium" : "low",
    preferredTypes: byType,
    meanRating: ratings.length === 0 ? undefined : ratings.reduce((a, b) => a + b, 0) / ratings.length
  };
}

/* ---------- learned settings ---------- */

export interface LearnedConfig {
  engine: "elena-learning-v1";
  /** Weight per "feature/type": above 1 means rank it higher, below 1 lower. Neutral (missing) is 1. */
  typeWeights: Record<string, number>;
  /** Same, but only for one state, written only where that state differs clearly from the national figure. */
  regionWeights: Record<string, Record<string, number>>;
  trainedOn: number;
}

export const EMPTY_CONFIG: LearnedConfig = { engine: "elena-learning-v1", typeWeights: {}, regionWeights: {}, trainedOn: 0 };
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Weight from a mean success against the overall mean, shrunk toward 1 for small groups and capped at +-MAX_SHIFT. */
export function weightFor(groupMean: number, groupN: number, overallMean: number): number {
  if (overallMean <= 0) return 1;
  const ratio = groupMean / overallMean;
  const shrunk = 1 + (ratio - 1) * (groupN / (groupN + SHRINK));
  return Math.round(clamp(shrunk, 1 - MAX_SHIFT, 1 + MAX_SHIFT) * 1000) / 1000;
}

export interface Proposal { config: LearnedConfig; sample: number; enough: boolean; notes: string[] }

/** The monthly retrain. Under MIN_SAMPLE scored suggestions it proposes nothing (an empty config) and says so. */
export function proposeConfig(facts: readonly SuggestionFact[]): Proposal {
  const scored = facts.map(f => ({ f, s: successScore(f) })).filter((x): x is { f: SuggestionFact; s: number } => x.s !== undefined);
  if (scored.length < MIN_SAMPLE) return { config: { ...EMPTY_CONFIG, trainedOn: scored.length }, sample: scored.length, enough: false, notes: [`Only ${scored.length} scored suggestions; ${MIN_SAMPLE} are needed before Elena proposes changes.`] };
  const overall = scored.reduce((a, x) => a + x.s, 0) / scored.length;
  const groupMean = (xs: typeof scored) => xs.reduce((a, x) => a + x.s, 0) / xs.length;
  const byKey = new Map<string, typeof scored>();
  for (const x of scored) byKey.set(`${x.f.feature}/${x.f.type}`, [...(byKey.get(`${x.f.feature}/${x.f.type}`) ?? []), x]);
  const typeWeights: Record<string, number> = {};
  const regionWeights: Record<string, Record<string, number>> = {};
  const notes: string[] = [];
  for (const [key, xs] of byKey) {
    if (xs.length < MIN_GROUP) continue;
    const w = weightFor(groupMean(xs), xs.length, overall);
    if (w !== 1) typeWeights[key] = w;
    const regions = new Map<string, typeof scored>();
    for (const x of xs) if (x.f.region) regions.set(x.f.region, [...(regions.get(x.f.region) ?? []), x]);
    for (const [region, rs] of regions) {
      if (rs.length < MIN_GROUP || Math.abs(groupMean(rs) - groupMean(xs)) < REGION_GAP) continue;
      (regionWeights[region] ??= {})[key] = weightFor(groupMean(rs), rs.length, overall);
      notes.push(`${region} differs from the national result for ${key} (${Math.round(groupMean(rs) * 100)}% vs ${Math.round(groupMean(xs) * 100)}%).`);
    }
  }
  return { config: { engine: "elena-learning-v1", typeWeights, regionWeights, trainedOn: scored.length }, sample: scored.length, enough: true, notes };
}

/** Re-orders candidate suggestions by the active config. With no config, or a type it has not learned, the order is unchanged. */
export function rankSuggestions<T extends { feature: Feature; type: string; baseScore: number }>(config: LearnedConfig | undefined, region: string | undefined, candidates: readonly T[]): T[] {
  if (!config) return [...candidates];
  const w = (c: T) => (region ? config.regionWeights[region]?.[`${c.feature}/${c.type}`] : undefined) ?? config.typeWeights[`${c.feature}/${c.type}`] ?? 1;
  return candidates.map((c, i) => ({ c, i, v: c.baseScore * w(c) })).sort((a, b) => b.v - a.v || a.i - b.i).map(x => x.c);
}

/* ---------- A/B testing ---------- */

/** Stable arm for a subject: the same person and experiment always get the same arm, with no stored assignment. */
export function assignArm(experimentKey: string, subjectId: string, arms: readonly string[]): string {
  let h = 2166136261;
  for (const ch of `${experimentKey}:${subjectId}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return arms[h % arms.length]!;
}

export interface ArmResult { arm: string; n: number; successRate: number; meanSuccess: number | undefined }
export interface ExperimentResult { arms: ArmResult[]; winner: string | undefined; z: number | undefined; note: string }

/** Two-proportion z test on "accepted or modified". A winner is named only when |z| >= 1.96 and both arms have MIN_GROUP reactions. */
export function experimentResult(facts: readonly SuggestionFact[], arms: readonly string[]): ExperimentResult {
  const stats = arms.map(arm => {
    const xs = facts.filter(f => f.arm === arm && f.action !== undefined);
    const wins = xs.filter(f => f.action === "accepted" || f.action === "modified").length;
    const sc = xs.map(successScore).filter((s): s is number => s !== undefined);
    return { arm, n: xs.length, wins, successRate: xs.length === 0 ? 0 : wins / xs.length, meanSuccess: sc.length === 0 ? undefined : sc.reduce((a, b) => a + b, 0) / sc.length };
  });
  const out = stats.map(({ wins: _w, ...r }) => r);
  const [a, b] = [...stats].sort((x, y) => y.successRate - x.successRate);
  if (!a || !b || a.n < MIN_GROUP || b.n < MIN_GROUP) return { arms: out, winner: undefined, z: undefined, note: `Each arm needs ${MIN_GROUP} reactions before a result is shown.` };
  const pooled = (a.wins + b.wins) / (a.n + b.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
  const z = se === 0 ? 0 : (a.successRate - b.successRate) / se;
  return { arms: out, winner: z >= 1.96 ? a.arm : undefined, z: Math.round(z * 100) / 100, note: z >= 1.96 ? `Arm ${a.arm} is better (z = ${z.toFixed(2)}).` : "No clear winner yet." };
}

/* ---------- health ---------- */

export interface Outcome { outcome: "settled" | "fell_through"; timeToSettlementDays?: number | undefined; negotiationCount?: number | undefined; satisfaction?: number | undefined }

export interface Health {
  suggestions: number;
  /** Share of suggestions with at least one recorded reaction. Target CAPTURE_TARGET. */
  captureRate: number;
  captureOk: boolean;
  acceptanceRate: number;
  previousAcceptanceRate: number | undefined;
  acceptanceChange: number | undefined;
  settlementRate: number | undefined;
  medianDaysToSettlement: number | undefined;
  meanRating: number | undefined;
  meanSatisfaction: number | undefined;
  helpfulYesRate: number | undefined;
}

const acceptRate = (xs: readonly SuggestionFact[]) => {
  const r = xs.filter(x => x.action !== undefined);
  return r.length === 0 ? 0 : r.filter(x => x.action === "accepted" || x.action === "modified").length / r.length;
};

/** Model health: is the feedback loop capturing interactions, and is acceptance and settlement improving? Compares the last 30 days with the 30 before. */
export function healthOf(facts: readonly SuggestionFact[], outcomes: readonly Outcome[], nowIso: string): Health {
  const now = Date.parse(nowIso), day = 86_400_000;
  const recent = facts.filter(f => now - Date.parse(f.createdAt) <= 30 * day);
  const before = facts.filter(f => { const age = now - Date.parse(f.createdAt); return age > 30 * day && age <= 60 * day; });
  const captured = facts.filter(f => f.action !== undefined).length;
  const settled = outcomes.filter(o => o.outcome === "settled");
  const days = settled.map(o => o.timeToSettlementDays).filter((d): d is number => d !== undefined);
  const ratings = facts.map(f => f.rating).filter((r): r is number => r !== undefined);
  const sat = outcomes.map(o => o.satisfaction).filter((s): s is number => s !== undefined);
  const help = facts.filter(f => f.helpful !== undefined);
  const cur = acceptRate(recent), prev = before.filter(f => f.action !== undefined).length >= MIN_GROUP ? acceptRate(before) : undefined;
  const captureRate = facts.length === 0 ? 0 : captured / facts.length;
  return {
    suggestions: facts.length, captureRate, captureOk: facts.length > 0 && captureRate >= CAPTURE_TARGET,
    acceptanceRate: acceptRate(facts), previousAcceptanceRate: prev, acceptanceChange: prev === undefined ? undefined : Math.round((cur - prev) * 1000) / 1000,
    settlementRate: outcomes.length === 0 ? undefined : settled.length / outcomes.length,
    medianDaysToSettlement: median(days),
    meanRating: ratings.length === 0 ? undefined : ratings.reduce((a, b) => a + b, 0) / ratings.length,
    meanSatisfaction: sat.length === 0 ? undefined : sat.reduce((a, b) => a + b, 0) / sat.length,
    helpfulYesRate: help.length === 0 ? undefined : help.filter(f => f.helpful === "yes").length / help.length
  };
}

/** The one place the platform states how Elena differs from a general-purpose model: what her advice is grounded in. Shown on the dashboard. */
export function differentiators(h: Health, config: LearnedConfig | undefined): string[] {
  const out = ["Suggestions are checked against Australian state rules, the platform wording filter and the seller's floor price before anyone sees them."];
  out.push(h.suggestions === 0 ? "Elena has not recorded any suggestions yet." : `Elena has recorded ${h.suggestions} suggestions and learns from what people actually did with them.`);
  if (config && config.trainedOn > 0) out.push(`The active settings were learned from ${config.trainedOn} scored suggestions, with ${Object.keys(config.regionWeights).length} state-specific adjustments.`);
  if (h.settlementRate !== undefined) out.push(`Settlement outcomes feed back in: ${Math.round(h.settlementRate * 100)}% of tracked deals settled.`);
  return out;
}

/* ---------- wiring: which features read the learned settings ---------- */

/** The arm that always gets the original behaviour. In a test that has this arm, every other arm gets the active learned settings. */
export const CONTROL_ARM = "control";

/** Features whose code reads the active learned settings. The rest only record suggestions and reactions. Keep in step with the code. */
export const WEIGHT_READERS: readonly Feature[] = ["negotiation_coach", "mediation", "lead_scoring"];

/** Learned settings apply when a config is active and the person's test arm (if a test runs) is not the control arm. */
export const weightsApply = (config: LearnedConfig | undefined, arm: string | undefined): boolean =>
  config !== undefined && Object.keys(config.typeWeights).length + Object.keys(config.regionWeights).length > 0 && arm !== CONTROL_ARM;

export interface FeatureCoverage { feature: Feature; readsWeights: boolean; suggestions: number; withReaction: number; coverage: number; weightedShare: number; ok: boolean }

/** Per feature, over the last 30 days: does it read the weights, how much of what it suggested has a recorded reaction, how much used weights. */
export function featureCoverage(facts: readonly SuggestionFact[], nowIso: string): FeatureCoverage[] {
  const cutoff = Date.parse(nowIso) - 30 * 86_400_000;
  return FEATURES.map(feature => {
    const xs = facts.filter(f => f.feature === feature && Date.parse(f.createdAt) >= cutoff);
    const withReaction = xs.filter(f => f.action !== undefined).length;
    const weighted = xs.filter(f => f.context["weighted"] === true).length;
    const coverage = xs.length === 0 ? 0 : withReaction / xs.length;
    return { feature, readsWeights: WEIGHT_READERS.includes(feature), suggestions: xs.length, withReaction, coverage, weightedShare: xs.length === 0 ? 0 : weighted / xs.length, ok: xs.length > 0 && coverage >= CAPTURE_TARGET };
  }).filter(c => c.suggestions > 0 || c.readsWeights);
}

/** Wilson score interval for a rate. */
export function wilsonInterval(successes: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 0 };
  const p = successes / n, z2 = z * z, d = 1 + z2 / n, c = p + z2 / (2 * n), m = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { lower: Math.max(0, (c - m) / d), upper: Math.min(1, (c + m) / d) };
}

export interface ArmReport extends ArmResult { lower: number; upper: number; dealsKnown: number; conversion: number | undefined; medianDays: number | undefined; meanRating: number | undefined }
export interface ExperimentReport extends ExperimentResult { arms: ArmReport[] }

/** experimentResult plus, per arm: a 95% interval on the acceptance rate, the share of known deals that settled, median days to settle and mean rating. */
export function experimentReport(facts: readonly SuggestionFact[], arms: readonly string[]): ExperimentReport {
  const base = experimentResult(facts, arms);
  return {
    ...base,
    arms: base.arms.map(a => {
      const xs = facts.filter(f => f.arm === a.arm);
      const reacted = xs.filter(f => f.action !== undefined), wins = reacted.filter(f => f.action === "accepted" || f.action === "modified").length;
      const deals = xs.filter(f => f.dealOutcome !== undefined), settled = deals.filter(f => f.dealOutcome === "settled");
      const ratings = xs.map(f => f.rating).filter((r): r is number => r !== undefined);
      return {
        ...a, ...wilsonInterval(wins, reacted.length), dealsKnown: deals.length, conversion: deals.length === 0 ? undefined : settled.length / deals.length,
        medianDays: median(settled.map(f => f.dealDays).filter((d): d is number => d !== undefined)),
        meanRating: ratings.length === 0 ? undefined : ratings.reduce((x, y) => x + y, 0) / ratings.length
      };
    })
  };
}

/** When to retrain next: said in plain words for the dashboard. */
export function nextUpdateAdvice(scored: number, activeSince: string | undefined, nowIso: string, hasProposed: boolean): string {
  if (hasProposed) return "A proposed version is waiting. Review it and activate it, ideally as an A/B test first.";
  if (scored < MIN_SAMPLE) return `Wait. ${MIN_SAMPLE - scored} more scored suggestions are needed before Elena can propose weights.`;
  if (!activeSince) return "Run the monthly job now: there is enough data and nothing is active yet.";
  const days = Math.floor((Date.parse(nowIso) - Date.parse(activeSince)) / 86_400_000);
  return days >= 30 ? `Run the monthly job now: the active version is ${days} days old.` : `Next update in about ${30 - days} days (the active version is ${days} days old).`;
}

/** Lead-scoring weights with the learned multiplier for each signal (engagement, fit, follow-up). A signal not learned keeps its staff-set weight. */
export function adjustLeadWeights<W extends { engagement: number; fit: number; followUp: number }>(config: LearnedConfig | undefined, weights: W): W {
  if (!config) return weights;
  const m = (signal: string) => config.typeWeights[`lead_scoring/${signal}`] ?? 1;
  return { ...weights, engagement: weights.engagement * m("engagement"), fit: weights.fit * m("fit"), followUp: weights.followUp * m("follow_up") };
}
