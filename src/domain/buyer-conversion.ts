import type { Actor, Failure, Result } from "./listing-service";
import { gate, type WorkspaceDeps } from "./agent-workspace";

/**
 * Buyer conversion scoring (pure, rules only; "conv-v1"). Estimates how likely a buyer on one of the agent's listings is to make an offer,
 * says why, profiles the buyer and recommends when and about what the agent should make contact. Staff-set rules for the
 * enquiry-engagement score live in lead-scoring.ts; this is a separate, behaviour-based estimate. It never decides anything:
 * it only ranks and suggests, and every signal behind a score is returned so the agent can see it.
 * Learning: tracked outcomes (offer made within 30 days of a score) feed calibration() once a band has enough results.
 */
export const MODEL_VERSION = "conv-v1";
export const OUTCOME_WINDOW_DAYS = 30;
export const MIN_CALIBRATION_SAMPLE = 30;
const DAY = 86_400_000;
export const HOT_MIN = 65;
export const WARM_MIN = 35;

export type Tier = "red" | "yellow" | "green";
export type Confidence = "high" | "medium" | "low";
export type Window = "24h" | "this_week" | "two_weeks" | "none";
export type Topic = "reply" | "confirm_financing" | "schedule_inspection" | "book_viewing" | "negotiate_price" | "send_comps" | "viewing_feedback" | "check_in";

/** Everything the score reads about one buyer on one listing. Missing optional fields mean "not known", never "no". */
export interface BuyerFacts {
  enquiryId: string; listingId: string; listingTitle: string; buyerId: string; buyerName: string;
  enquiredAt: string;
  listingPriceCents?: number;
  views: number; saved: boolean;
  buyerMessages: number; agentMessages: number; lastBuyerMessageAt?: string; lastAgentContactAt?: string;
  viewingsRequested: number; viewingsConfirmed: number; viewingsCancelled: number; lastViewingAt?: string;
  inspectionsRequested: number; inspectionsScheduled: number; inspectionsCancelled: number;
  offers: number; latestOfferStatus?: string; latestOfferCents?: number; counterRounds: number;
  idVerified?: boolean;
  /** Pre-approved lending limit, when the platform holds one. Not collected yet; the score copes without it. */
  preApprovalCents?: number;
  /** The buyer's activity on the agent's other listings and elsewhere: a measure of whether they are shopping around. */
  otherEnquiries: number; priorOffersElsewhere: number;
  lastActivityAt?: string;
  stage?: string; followUpAt?: string;
}

export interface Signal { label: string; points: number; kind: "engagement" | "firmness" | "timeline" | "risk" }
export interface Profile {
  experience: "returning" | "new";
  intent: "motivated" | "exploratory";
  speed: "fast" | "steady" | "slow" | "not_yet";
  focus: "focused" | "comparing" | "shopping";
  notes: string[];
}
export interface FollowUp { window: Window; inDays: number; dueBy?: string; topic?: Topic; text: string; confidence: Confidence }
export interface ConversionScore {
  enquiryId: string; listingId: string; listingTitle: string; buyerId: string; buyerName: string;
  probability: number; modelProbability: number; tier: Tier; closed: boolean; confidence: Confidence;
  signals: Signal[]; profile: Profile; followUp: FollowUp; daysSinceContact?: number; overdue: boolean; modelVersion: string;
}

const ageDays = (iso: string | undefined, now: Date): number => (iso ? Math.max(0, (now.getTime() - Date.parse(iso)) / DAY) : Infinity);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const tierFor = (p: number): Tier => (p >= HOT_MIN ? "red" : p >= WARM_MIN ? "yellow" : "green");

function signalsFor(f: BuyerFacts, now: Date): Signal[] {
  const out: Signal[] = [];
  const add = (kind: Signal["kind"], points: number, label: string) => { if (points !== 0) out.push({ kind, points, label }); };

  // Engagement (capped at +35).
  const eng: Signal[] = [];
  const e = (points: number, label: string) => eng.push({ kind: "engagement", points, label });
  if (f.views >= 6) e(10, `Viewed the listing ${f.views} times`); else if (f.views >= 3) e(6, `Viewed the listing ${f.views} times`); else if (f.views >= 1) e(3, "Viewed the listing");
  if (f.saved) e(6, "Saved the listing");
  if (f.buyerMessages > 0) e(Math.min(f.buyerMessages, 4) * 2.5, `${f.buyerMessages} message${f.buyerMessages === 1 ? "" : "s"} from the buyer`);
  if (f.viewingsConfirmed > 0) e(8, "Viewing confirmed"); else if (f.viewingsRequested > 0) e(4, "Asked for a viewing");
  if (f.inspectionsScheduled > 0) e(12, "Building inspection scheduled"); else if (f.inspectionsRequested > 0) e(7, "Asked for a building inspection");
  let engTotal = 0;
  for (const s of eng) { const room = 35 - engTotal; if (room <= 0) break; const pts = Math.min(s.points, room); engTotal += pts; out.push({ ...s, points: pts }); }

  // Firmness (capped at +45).
  const firm: Signal[] = [];
  const fm = (points: number, label: string) => firm.push({ kind: "firmness", points, label });
  if (f.offers > 0) {
    fm(25, "Has made a formal offer");
    const ratio = f.listingPriceCents && f.latestOfferCents ? f.latestOfferCents / f.listingPriceCents : undefined;
    if (ratio !== undefined && ratio >= 1) fm(10, "Offer at or above the asking price");
    else if (ratio !== undefined && ratio >= 0.95) fm(6, "Offer within 5% of the asking price");
  }
  if (f.preApprovalCents !== undefined && f.listingPriceCents) {
    if (f.preApprovalCents >= f.listingPriceCents) fm(12, "Pre-approval covers the asking price"); else fm(4, "Pre-approved, but below the asking price");
  }
  if (f.idVerified) fm(8, "Identity verified");
  let firmTotal = 0;
  for (const s of firm) { const room = 45 - firmTotal; if (room <= 0) break; const pts = Math.min(s.points, room); firmTotal += pts; out.push({ ...s, points: pts }); }

  // Timeline.
  const quiet = ageDays(f.lastActivityAt ?? f.enquiredAt, now);
  if (quiet <= 2) add("timeline", 12, "Active in the last 2 days");
  else if (quiet <= 7) add("timeline", 6, "Active in the last week");
  else if (quiet > 30) add("timeline", -18, "Quiet for over a month");
  else if (quiet > 14) add("timeline", -8, "Quiet for over 2 weeks");
  const sinceEnquiry = ageDays(f.enquiredAt, now);
  if (f.views + f.buyerMessages === 0 && sinceEnquiry > 7) add("timeline", -6, "Enquired but has done nothing since");

  // Risk signals.
  const cancels = f.viewingsCancelled + f.inspectionsCancelled;
  if (cancels > 0) add("risk", -Math.min(cancels, 3) * 4, `${cancels} cancelled or rescheduled booking${cancels === 1 ? "" : "s"}`);
  const lowball = f.listingPriceCents && f.latestOfferCents ? f.latestOfferCents / f.listingPriceCents < 0.9 : false;
  if (f.counterRounds >= 2 || lowball) add("risk", -6, lowball ? "Offer more than 10% under asking" : `${f.counterRounds} rounds of price negotiation`);
  if (f.otherEnquiries >= 3) add("risk", -8, `Also enquired on ${f.otherEnquiries} other properties`);
  else if (f.otherEnquiries >= 1) add("risk", -3, `Also enquired on ${f.otherEnquiries} other propert${f.otherEnquiries === 1 ? "y" : "ies"}`);
  return out;
}

const confidenceFor = (f: BuyerFacts, now: Date): Confidence => {
  const sources = [
    f.views > 0 || f.saved, f.buyerMessages > 0, f.viewingsRequested + f.inspectionsRequested > 0, f.offers > 0,
    f.idVerified !== undefined, f.preApprovalCents !== undefined
  ].filter(Boolean).length;
  const behavioural = f.views > 0 || f.saved || f.viewingsRequested + f.inspectionsRequested + f.offers > 0;
  if (ageDays(f.enquiredAt, now) < 1 && sources < 3) return "low";
  if (sources >= 4 && behavioural) return "high";
  return sources >= 2 && behavioural ? "medium" : "low";
};

function profileFor(f: BuyerFacts, now: Date): Profile {
  const notes: string[] = [];
  const motivated = f.offers > 0 || f.inspectionsScheduled > 0 || f.viewingsConfirmed > 0 || (f.preApprovalCents !== undefined && f.preApprovalCents > 0);
  const returning = f.priorOffersElsewhere > 0 || f.otherEnquiries >= 4;
  if (returning) notes.push("Has made offers or enquired widely on the platform before");
  const hasFirmStep = f.viewingsRequested + f.inspectionsRequested + f.offers > 0;
  let speed: Profile["speed"] = "not_yet";
  if (hasFirmStep) {
    // Without per-step timestamps for every table, use how soon the buyer acted relative to the enquiry's age.
    const days = f.lastViewingAt ? Math.max(0, (Date.parse(f.lastViewingAt) - Date.parse(f.enquiredAt)) / DAY) : ageDays(f.enquiredAt, now);
    speed = days <= 3 ? "fast" : days <= 10 ? "steady" : "slow";
  }
  const focus: Profile["focus"] = f.otherEnquiries >= 3 ? "shopping" : f.otherEnquiries >= 1 ? "comparing" : "focused";
  if (focus === "focused") notes.push("Only enquiring on this property");
  if (f.preApprovalCents === undefined) notes.push("Pre-approval not on file");
  return { experience: returning ? "returning" : "new", intent: motivated ? "motivated" : "exploratory", speed, focus, notes };
}

const windowFor = (inDays: number): Window => (inDays <= 1 ? "24h" : inDays <= 7 ? "this_week" : "two_weeks");

function followUpFor(f: BuyerFacts, tier: Tier, closed: boolean, confidence: Confidence, overdue: boolean, now: Date): FollowUp {
  if (closed) return { window: "none", inDays: 0, text: "No contact needed.", confidence };
  const sinceContact = ageDays(f.lastAgentContactAt, now);
  const waiting = f.buyerMessages > 0 && (!f.lastAgentContactAt || (f.lastBuyerMessageAt !== undefined && f.lastBuyerMessageAt > f.lastAgentContactAt));
  const openOffer = f.latestOfferStatus !== undefined && ["submitted", "under_review", "countered", "buyer_countered"].includes(f.latestOfferStatus);
  const lowOffer = f.listingPriceCents && f.latestOfferCents ? f.latestOfferCents < f.listingPriceCents : false;
  const recentViewing = f.lastViewingAt !== undefined && ageDays(f.lastViewingAt, now) <= 2 && Date.parse(f.lastViewingAt) <= now.getTime();

  let topic: Topic, urgent = false;
  if (waiting) { topic = "reply"; urgent = true; }
  else if (openOffer) { topic = f.counterRounds > 0 || lowOffer ? "negotiate_price" : "confirm_financing"; urgent = true; }
  else if (recentViewing) { topic = "viewing_feedback"; urgent = true; }
  else if (f.preApprovalCents === undefined && (f.inspectionsScheduled > 0 || f.viewingsConfirmed > 0 || tier === "red")) topic = "confirm_financing";
  else if (f.viewingsConfirmed + f.viewingsRequested === 0) topic = f.views >= 3 || f.saved ? "book_viewing" : "send_comps";
  else if (f.inspectionsScheduled + f.inspectionsRequested === 0 && tier !== "green") topic = "schedule_inspection";
  else topic = tier === "green" ? "check_in" : "send_comps";

  const gap = urgent || overdue || tier === "red" ? 0 : tier === "yellow" ? 4 : 10;
  // Do not suggest chasing someone the agent spoke to a moment ago; a lead never contacted starts partway into its window.
  const inDays = gap === 0 ? 0 : Number.isFinite(sinceContact) ? Math.max(0, Math.ceil(gap - sinceContact)) : tier === "yellow" ? 2 : 10;
  const window = windowFor(inDays);
  const due = new Date(now.getTime() + inDays * DAY).toISOString().slice(0, 10);
  const when = inDays === 0 ? "Contact today" : inDays === 1 ? "Contact tomorrow" : `Contact in ${inDays} days`;
  return { window, inDays, dueBy: due, topic, text: `${when}: ${TOPIC_TEXT[topic]}.`, confidence };
}

export const TOPIC_TEXT: Record<Topic, string> = {
  reply: "answer the buyer's message", confirm_financing: "confirm their financing", schedule_inspection: "offer a building inspection",
  book_viewing: "offer a viewing", negotiate_price: "talk through price", send_comps: "send comparable sales", viewing_feedback: "ask how the viewing went", check_in: "a light check-in"
};

/** Probability a buyer makes an offer (0-100), with signals, profile and follow-up advice. `calibrate` maps the model's number onto observed results. */
export function scoreBuyer(f: BuyerFacts, now: Date, calibrate?: (modelProbability: number) => number): ConversionScore {
  const closed = f.stage === "won" || f.stage === "lost" || f.latestOfferStatus === "accepted";
  const signals = signalsFor(f, now);
  const modelProbability = f.latestOfferStatus === "accepted" ? 99 : clamp(Math.round(10 + signals.reduce((s, x) => s + x.points, 0)), 1, 98);
  const probability = closed ? modelProbability : clamp(Math.round(calibrate ? calibrate(modelProbability) : modelProbability), 1, 98);
  const tier = tierFor(probability);
  const confidence = confidenceFor(f, now);
  const today = now.toISOString().slice(0, 10);
  const overdue = !closed && !!f.followUpAt && f.followUpAt < today;
  const sinceContact = ageDays(f.lastAgentContactAt, now);
  return {
    enquiryId: f.enquiryId, listingId: f.listingId, listingTitle: f.listingTitle, buyerId: f.buyerId, buyerName: f.buyerName,
    probability, modelProbability, tier, closed, confidence, signals, profile: profileFor(f, now),
    followUp: followUpFor(f, tier, closed, confidence, overdue, now),
    ...(Number.isFinite(sinceContact) ? { daysSinceContact: Math.floor(sinceContact) } : {}),
    overdue, modelVersion: MODEL_VERSION
  };
}

/** Hot leads pinned first, then by probability; closed leads last. */
export function rankBuyers(facts: readonly BuyerFacts[], now: Date, calibrate?: (p: number) => number): ConversionScore[] {
  const rank = (s: ConversionScore) => (s.closed ? 2 : s.tier === "red" ? 0 : 1);
  return facts.map(f => scoreBuyer(f, now, calibrate)).sort((a, b) =>
    rank(a) - rank(b) || b.probability - a.probability || Number(b.overdue) - Number(a.overdue) || (a.enquiryId < b.enquiryId ? -1 : 1));
}

/* ---------------- accuracy and calibration ---------------- */

export interface Resolved { probability: number; converted: boolean }
export interface Bucket { lo: number; n: number; converted: number }
export interface Accuracy {
  resolved: number; enough: boolean; brier?: number; hitRate?: number;
  byTier: { tier: Tier; n: number; conversionRate?: number }[];
  buckets: Bucket[];
}

/** Predicted score against what happened. Brier is the mean squared error of the probability (0 is perfect, 0.25 is a coin flip). */
export function evaluateAccuracy(rows: readonly Resolved[]): Accuracy {
  const n = rows.length;
  const buckets = new Map<number, Bucket>();
  const tiers: Record<Tier, { n: number; c: number }> = { red: { n: 0, c: 0 }, yellow: { n: 0, c: 0 }, green: { n: 0, c: 0 } };
  let sq = 0, hits = 0;
  for (const r of rows) {
    const p = r.probability / 100, y = r.converted ? 1 : 0;
    sq += (p - y) ** 2;
    if ((p >= 0.5) === r.converted) hits++;
    const lo = Math.min(90, Math.floor(r.probability / 10) * 10);
    const b = buckets.get(lo) ?? { lo, n: 0, converted: 0 };
    b.n++; b.converted += y; buckets.set(lo, b);
    const t = tiers[tierFor(r.probability)]; t.n++; t.c += y;
  }
  return {
    resolved: n, enough: n >= MIN_CALIBRATION_SAMPLE,
    ...(n > 0 ? { brier: Math.round((sq / n) * 1000) / 1000, hitRate: Math.round((hits / n) * 100) } : {}),
    byTier: (["red", "yellow", "green"] as const).map(tier => ({ tier, n: tiers[tier].n, ...(tiers[tier].n > 0 ? { conversionRate: Math.round((tiers[tier].c / tiers[tier].n) * 100) } : {}) })),
    buckets: [...buckets.values()].sort((a, b) => a.lo - b.lo)
  };
}

/**
 * Pulls the model's number toward what actually happened in its 10-point band, but only once the band has MIN_CALIBRATION_SAMPLE results
 * (weighted by how many). With less data it returns the model's number unchanged, so early scores are never distorted by a few outcomes.
 */
export function makeCalibrator(buckets: readonly Bucket[]): (p: number) => number {
  const by = new Map(buckets.map(b => [b.lo, b]));
  return p => {
    const b = by.get(Math.min(90, Math.floor(p / 10) * 10));
    if (!b || b.n < MIN_CALIBRATION_SAMPLE) return p;
    const w = b.n / (b.n + MIN_CALIBRATION_SAMPLE);
    return p * (1 - w) + (b.converted / b.n) * 100 * w;
  };
}

/* ---------------- service ---------------- */

export interface ConversionDeps extends Pick<WorkspaceDeps, "licences" | "today" | "now"> {
  facts(agentId: string): Promise<BuyerFacts[]>;
  buckets(): Promise<Bucket[]>;
  /** Keeps one snapshot per lead per day so results can be compared with what the buyer later did. */
  snapshot(agentId: string, rows: readonly ConversionScore[], day: string): Promise<void>;
  accuracy(): Promise<Resolved[]>;
}

export interface ConversionView { leads: ConversionScore[]; summary: { red: number; yellow: number; green: number; closed: number }; accuracy: Accuracy }

export async function getBuyerConversion(d: ConversionDeps, a: Actor): Promise<Result<ConversionView>> {
  const denied: Failure | undefined = await gate(d, a); if (denied) return denied;
  // facts() first: it records any offers made since the last visit, which accuracy and calibration then include.
  const facts = await d.facts(a.userId);
  const [buckets, resolved] = await Promise.all([d.buckets(), d.accuracy()]);
  const leads = rankBuyers(facts, d.now(), makeCalibrator(buckets));
  await d.snapshot(a.userId, leads, d.today());
  const open = leads.filter(l => !l.closed);
  return { ok: true, value: { leads, summary: { red: open.filter(l => l.tier === "red").length, yellow: open.filter(l => l.tier === "yellow").length, green: open.filter(l => l.tier === "green").length, closed: leads.length - open.length }, accuracy: evaluateAccuracy(resolved) } };
}
