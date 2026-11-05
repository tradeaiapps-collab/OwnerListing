import { AMENITIES, AMENITY_LABELS, formatAud, type Amenity } from "./listing-details";
import { ABSOLUTE, ADVERSE_NOTICE, REPORTS_NOTICE, checkSuggestion } from "./ai-description";
import { AI_SUGGESTION_LABEL, CONTACT_RE } from "./ai-engine";
import { scanForDiscrimination } from "./discrimination-filter";
import { fieldTips, type TipField } from "./listing-assistant-tips";
import { readBrand } from "../config/brand";
import { PORTAL_LABELS } from "./syndication";
import { groupOf, roundTo, type PriceEstimate } from "./price-guidance";

/**
 * Elena's listing assistant: guided creation of a listing. Everything here is pure and rule based (no external AI account),
 * advisory only, and works from what the owner or agent has typed so far. Nothing is saved or published by this module.
 *
 * Safe by design:
 *  - Questions, tags, photo shots and marketing angles come from fixed vocabularies, so nothing free-form is learned or stored.
 *  - Rewrites only reorder, trim or clean the author's own text; they never add features, measurements, prices or condition claims.
 *  - Marketing angles describe the property, never who should buy or rent it (see discrimination-filter.ts).
 *  - Pricing never suggests quoting below the estimated range (underquoting is unlawful in several states).
 */

export interface AssistantFacts {
  transactionType: "sale" | "rent";
  propertyType: string;
  title?: string;
  description?: string;
  suburb?: string;
  postcode?: string;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
  priceCents?: number;
  amenities?: readonly string[];
  photoCount?: number;
}

const wordCount = (t: string) => (t.trim() === "" ? 0 : t.trim().split(/\s+/).length);
const isResidentialBuilt = (p: string) => groupOf(p) === "house" || groupOf(p) === "attached" || groupOf(p) === "unit";

export { fieldTips, TIP_FIELDS, type TipField } from "./listing-assistant-tips";

// ---- Clarifying questions ---------------------------------------------------------------------------------------------------------

export const QUESTION_IDS = ["suburb", "bedrooms", "bathrooms", "parking", "price", "love", "outdoor", "renovation", "nearby", "furnished", "pets", "photos"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];
export interface AssistantQuestion { id: QuestionId; question: string; why: string; /** Form field to focus, or "description". */ target: string; essential: boolean }

const MENTIONS = {
  outdoor: /\b(garden|yard|lawn|deck|patio|alfresco|courtyard|balcon|terrace|outdoor)/i,
  renovation: /\b(renovat|refurbish|updated|new(ly)? (kitchen|bathroom|floors?|roof|paint)|remodel)/i,
  nearby: /\b(walk|close to|near|minutes?|train|bus|tram|shops?|schools?|park|cafes?|village)\b/i
};

/** What Elena would ask next, most useful first. Questions the author keeps dismissing are skipped unless they are essential. */
export function clarifyingQuestions(f: AssistantFacts, profile: LearnedProfile = EMPTY_PROFILE, max = 4): AssistantQuestion[] {
  const rent = f.transactionType === "rent";
  const text = `${f.title ?? ""} ${f.description ?? ""}`;
  const built = isResidentialBuilt(f.propertyType);
  const am = new Set(f.amenities ?? []);
  const q: AssistantQuestion[] = [];
  const add = (x: AssistantQuestion) => q.push(x);
  if (!f.suburb?.trim()) add({ id: "suburb", question: "Which suburb is the property in?", why: "Buyers search by suburb, and Elena needs it to find recent nearby results.", target: "suburb", essential: true });
  if (built && f.bedrooms === undefined) add({ id: "bedrooms", question: "How many bedrooms does it have?", why: "Bedrooms are the first filter most searchers use.", target: "bedrooms", essential: true });
  if (built && f.bathrooms === undefined) add({ id: "bathrooms", question: "How many bathrooms, including any ensuite?", why: "It also improves the price comparison.", target: "bathrooms", essential: true });
  if (f.priceCents === undefined) {
    add({ id: "price", question: rent ? "What weekly rent are you thinking of?" : "What price do you have in mind?", why: "Elena can show how it compares with recent nearby results.", target: "price", essential: false });
  }
  if (wordCount(f.description ?? "") < 40) {
    add({ id: "love", question: "What are the three things you like most about the property?", why: "Specific features make a description far more useful than general praise. Elena can tidy what you write.", target: "description", essential: false });
  }
  if (built && f.parking === undefined) add({ id: "parking", question: "How many car spaces (garage, carport or off-street)?", why: "Parking is a common filter and affects the price comparison.", target: "parking", essential: false });
  if (isResidentialBuilt(f.propertyType) && groupOf(f.propertyType) !== "unit" && !MENTIONS.outdoor.test(text) && !am.has("garden") && !am.has("balcony")) {
    add({ id: "outdoor", question: "Is there a yard, deck, balcony or outdoor entertaining area?", why: "Outdoor space is one of the most searched features.", target: "description", essential: false });
  }
  if (built && !rent && !MENTIONS.renovation.test(text)) {
    add({ id: "renovation", question: "Has anything been renovated or replaced recently (kitchen, bathrooms, floors, roof)?", why: "Recent work is a strong selling point. Only say it if it is true.", target: "description", essential: false });
  }
  if (!MENTIONS.nearby.test(text)) {
    add({ id: "nearby", question: "What is within an easy walk or drive (shops, transport, parks)?", why: "Location details help buyers picture daily life.", target: "description", essential: false });
  }
  if (rent && !am.has("furnished") && !/furnished/i.test(text)) add({ id: "furnished", question: "Is it furnished or unfurnished?", why: "Renters filter by this, and the short-stay portals need to know.", target: "amenities", essential: false });
  if (rent && !am.has("pet_friendly") && !/\bpets?\b/i.test(text)) add({ id: "pets", question: "Are pets considered?", why: "It is a common search filter for rentals. Tick pet friendly if so.", target: "amenities", essential: false });
  if (f.photoCount !== undefined && f.photoCount < 6) add({ id: "photos", question: "Can you add more photos? Elena has a shot list.", why: "Buyers decide from the photos first.", target: "photos", essential: false });
  const dismissed = (id: QuestionId) => (profile.questions[id]?.dismissed ?? 0) >= 2;
  return q.filter(x => x.essential || !dismissed(x.id)).slice(0, max);
}

// ---- Auto-tagging --------------------------------------------------------------------------------------------------------------------

const AMENITY_RULES: Record<Amenity, RegExp> = {
  pool: /\b(swimming pool|lap pool|plunge pool|in-?ground pool|pool)\b/i,
  air_conditioning: /\b(air[- ]?con(ditioning)?|ducted (cooling|air)|split[- ]system|reverse cycle)\b/i,
  garage: /\b(garage|carport|lock[- ]?up)\b/i,
  balcony: /\b(balcon(y|ies)|terrace)\b/i,
  garden: /\b(garden|lawn|landscaped|backyard|courtyard)\b/i,
  solar: /\b(solar|photovoltaic|pv panels?)\b/i,
  pet_friendly: /\b(pet[- ]friendly|pets? (considered|welcome|allowed|negotiable))\b/i,
  furnished: /\b(fully |part(ly)? )?(?<!\bnot )(?<!un)furnished\b/i,
  ensuite: /\b(en-?suite)\b/i,
  study: /\b(study|home office|office nook)\b/i,
  lift: /\b(lift|elevator)\b/i,
  security: /\b(security|alarm|intercom|gated|cctv|video entry)\b/i
};

export const HIGHLIGHTS = [
  { id: "renovated", label: "Renovated", re: /\b(renovat\w*|refurbish\w*|updated (kitchen|bathrooms?)|new (kitchen|bathrooms?))\b/i },
  { id: "open_plan", label: "Open plan living", re: /\bopen[- ]plan\b/i },
  { id: "natural_light", label: "Natural light", re: /\b(natural light|light[- ]filled|sun-?drenched|north[- ]facing)\b/i },
  { id: "views", label: "Views", re: /\b(water|ocean|city|bay|river|mountain|bush|district) views?\b/i },
  { id: "near_transport", label: "Close to transport", re: /\b((train|bus|tram|ferry|light rail|metro) (station|stop|line)|(close|walk|near)\b[^.]{0,20}\btransport)\b/i },
  { id: "near_amenities", label: "Walk to shops and parks", re: /\b(walk|close|near|minutes?)\b[^.]{0,30}\b(shops|cafes?|village|parks?|schools?)\b/i },
  { id: "low_maintenance", label: "Low maintenance", re: /\b(low[- ]maintenance|easy[- ]care)\b/i },
  { id: "quiet", label: "Quiet street", re: /\b(quiet (street|location)|cul-de-sac)\b/i },
  { id: "entertaining", label: "Outdoor entertaining", re: /\b(entertain\w*|alfresco|bbq|barbecue|outdoor (living|area))\b/i },
  { id: "stone_kitchen", label: "Stone benchtops", re: /\b(stone (bench\w*|tops?)|caesarstone)\b/i },
  { id: "high_ceilings", label: "High ceilings", re: /\b(high ceilings?|\d(\.\d)?\s?m ceilings?)\b/i },
  { id: "timber_floors", label: "Timber floors", re: /\b((timber|hardwood|polished|bamboo) floor\w*)\b/i },
  { id: "storage", label: "Plenty of storage", re: /\b(storage|walk[- ]in[- ](robe|wardrobe)|built[- ]in (robes?|wardrobes?))\b/i }
] as const;
export type HighlightId = (typeof HIGHLIGHTS)[number]["id"];

export interface TagSuggestion {
  kind: "amenity" | "highlight";
  /** An AMENITIES value (kind amenity) or a HIGHLIGHTS id. */
  id: string;
  label: string;
  /** The words in the author's text that led to the tag. */
  evidence: string;
  /** 0 to 1, after learning. */
  score: number;
  /** For amenities: the box is already ticked. */
  alreadySet: boolean;
}

/** Shrinks a tag's score the author keeps dismissing and lifts one they keep accepting. Pure; the base score comes from the text match. */
export function adjustedScore(base: number, s?: { accepted: number; dismissed: number }): number {
  if (!s) return base;
  const rate = (s.accepted + 1) / (s.accepted + s.dismissed + 2);
  return Math.min(1, Math.max(0, base * (0.5 + rate)));
}

export function suggestTags(f: Pick<AssistantFacts, "title" | "description" | "amenities">, profile: LearnedProfile = EMPTY_PROFILE): TagSuggestion[] {
  const text = `${f.title ?? ""}. ${f.description ?? ""}`;
  const set = new Set(f.amenities ?? []);
  const out: TagSuggestion[] = [];
  for (const a of AMENITIES) {
    const m = AMENITY_RULES[a].exec(text);
    if (m) out.push({ kind: "amenity", id: a, label: AMENITY_LABELS[a], evidence: m[0], score: adjustedScore(0.9, profile.tags[a]), alreadySet: set.has(a) });
  }
  for (const h of HIGHLIGHTS) {
    const m = h.re.exec(text);
    if (m) out.push({ kind: "highlight", id: h.id, label: h.label, evidence: m[0], score: adjustedScore(0.8, profile.tags[h.id]), alreadySet: false });
  }
  // A tag the author has dismissed three times more than accepted is left out; the rest are best first.
  return out.filter(t => { const s = profile.tags[t.id]; return !s || s.dismissed - s.accepted < 3; }).sort((a, b) => b.score - a.score);
}

// ---- Description rewriter ----------------------------------------------------------------------------------------------------------

export const REWRITE_MODES = ["better", "shorter"] as const;
export type RewriteMode = (typeof REWRITE_MODES)[number];
export const isRewriteMode = (v: unknown): v is RewriteMode => v === "better" || v === "shorter";
export const MAX_REWRITE_INPUT = 5000;
export const SHORTER_DEFAULT_WORDS = 90;

export type Rewrite =
  | { state: "ready"; mode: RewriteMode; text: string; changes: string[]; beforeWords: number; afterWords: number; label: typeof AI_SUGGESTION_LABEL }
  | { state: "unchanged" | "unavailable"; message: string };

const HYPE = /\b(must (be )?see|must be seen|won'?t last( long)?|rare opportunity|once in a lifetime|dream home|an? (absolute|true) gem|don'?t miss( out)?|act fast|hurry|priced to sell|motivated (seller|vendor)|genuine seller)\b/gi;
const INTENSIFIERS = /\b(very|really|extremely|absolutely|truly|incredibly|simply|just)\s+/gi;
const FILLER: [RegExp, string][] = [
  [/\b(it is|it's) worth (noting|mentioning) that\s+/gi, ""],
  [/\bin addition to (this|that),?\s+/gi, ""],
  [/\bthat being said,?\s+/gi, ""],
  [/\bas well as\b/gi, "and"],
  [/\bin the vicinity of\b/gi, "near"],
  [/\bis located (in|at|on)\b/gi, "is in"],
  [/\bthe property (also )?(boasts|features|offers)\b/gi, "It has"]
];
const CLOSING = /\b(inspect|inspection|open home|by appointment|enquir|contact)/i;

const splitSentences = (t: string): string[] => t.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const isProtected = (s: string) => s.includes(REPORTS_NOTICE) || s.includes(ADVERSE_NOTICE);

const STOP = new Set(["the", "and", "with", "has", "have", "this", "that", "are", "was", "for", "its", "also", "home", "property", "house"]);
const FACT_RE = /\b(\d+|one|two|three|four|five|six)[- ]?(bed|bath|car|garage)/i;

function leadSentence(f: AssistantFacts): string | undefined {
  const parts: string[] = [];
  if (f.bedrooms !== undefined) parts.push(`${f.bedrooms} bedroom`);
  if (f.bathrooms !== undefined) parts.push(`${f.bathrooms} bathroom`);
  if (parts.length === 0) return undefined;
  const kind = f.propertyType === "other" ? "property" : f.propertyType;
  const where = f.suburb?.trim() ? ` in ${f.suburb.trim()}` : "";
  const car = f.parking !== undefined && f.parking > 0 ? ` with ${f.parking} car space${f.parking === 1 ? "" : "s"}` : "";
  return `A ${parts.join(", ")} ${kind}${where}${car}${f.transactionType === "rent" ? ", available to rent" : ""}.`;
}

function score(s: string): number {
  let n = 0;
  if (/\d/.test(s)) n += 2;
  n += HIGHLIGHTS.filter(h => h.re.test(s)).length * 2;
  n += AMENITIES.filter(a => AMENITY_RULES[a].test(s)).length * 2;
  if (/\b(walk|close|near|minutes?)\b/i.test(s)) n += 1;
  HYPE.lastIndex = 0;
  if (HYPE.test(s)) n -= 2;
  HYPE.lastIndex = 0;
  return n;
}

/**
 * Tidies or shortens the author's own description. It only removes, trims and reorders their words (plus one lead sentence built from
 * the details they entered), so it cannot add a claim. The result is checked like any AI suggestion and the author still approves it.
 */
export function rewriteDescription(text: string, mode: RewriteMode, facts: AssistantFacts, profile: LearnedProfile = EMPTY_PROFILE): Rewrite {
  const source = text.trim();
  if (source === "") return { state: "unavailable", message: "Write a few lines first, or answer Elena's questions, and she can improve them." };
  if (source.length > MAX_REWRITE_INPUT) return { state: "unavailable", message: "That description is too long to rewrite." };
  const changes: string[] = [];
  const note = (c: string) => { if (!changes.includes(c)) changes.push(c); };

  let sentences = splitSentences(source);
  // 1. Drop what must not stay: contact details, absolute condition claims and blocked wording (reports notices always stay).
  sentences = sentences.filter(s => {
    if (isProtected(s)) return true;
    if (CONTACT_RE.test(s)) { note("Removed contact details (they belong in enquiries, not the description)."); return false; }
    if (ABSOLUTE.some(re => re.test(s))) { note("Removed an absolute condition claim. Describe what a report says and cite it instead."); return false; }
    if (scanForDiscrimination(s).blocked) { note("Removed wording that states a preference for who may buy or rent."); return false; }
    return true;
  });
  // 2. Clean hype, shouting and filler inside each sentence.
  sentences = sentences.map(s => {
    if (isProtected(s)) return s;
    let t = s;
    t = t.replace(/\b[A-Z]{4,}\b/g, w => { note("Turned SHOUTING into normal case."); return w.charAt(0) + w.slice(1).toLowerCase(); });
    HYPE.lastIndex = 0;
    let hyped = false;
    if (HYPE.test(t)) { hyped = true; note("Removed sales pressure phrases."); HYPE.lastIndex = 0; t = t.replace(HYPE, ""); }
    if (INTENSIFIERS.test(t)) { note("Removed filler words like \"very\" and \"really\"."); INTENSIFIERS.lastIndex = 0; t = t.replace(INTENSIFIERS, ""); }
    INTENSIFIERS.lastIndex = 0;
    for (const [re, to] of FILLER) t = t.replace(re, to);
    // A short scrap left behind by a removed phrase ("This stunning home.") says nothing on its own.
    if (hyped && wordCount(t) <= 4 && !/\d/.test(t)) return "";
    t = t.replace(/!+/g, ".").replace(/\.{2,}/g, ".").replace(/\s+([,.;])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;.-]+/, "").trim();
    return t.length > 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }).filter(s => wordCount(s) >= 3 || isProtected(s));
  // 3. Drop repeats.
  const seen: Set<string>[] = [];
  sentences = sentences.filter(s => {
    const words = new Set(keyOf(s).split(" ").filter(w => w.length > 2 && !STOP.has(w)));
    const dup = words.size >= 3 && seen.some(w => { const inter = [...words].filter(x => w.has(x)).length; return inter / Math.min(words.size, w.size) > 0.85; });
    if (dup) { note("Removed a repeated sentence."); return false; }
    seen.push(words);
    return true;
  });
  // 4. Lead with the facts, close with the viewing line.
  const lead = leadSentence(facts);
  if (lead && !sentences.some(s => FACT_RE.test(s))) {
    sentences.unshift(lead);
    note("Added an opening line from the details you entered.");
  }
  const body = sentences.filter(s => !CLOSING.test(s) || isProtected(s));
  const closing = sentences.filter(s => CLOSING.test(s) && !isProtected(s));
  let ordered = [...body, ...closing];
  if (closing.length > 0 && body.length > 0) note("Moved the viewing line to the end.");

  if (mode === "shorter") {
    const target = shorterTarget(profile);
    const total = () => ordered.reduce((n, s) => n + wordCount(s), 0);
    if (total() > target) {
      const ranked = ordered.map((s, i) => ({ s, i, v: (isProtected(s) || s === lead ? 99 : score(s)) - i * 0.01 })).sort((a, b) => b.v - a.v);
      const keep = new Set<number>();
      let words = 0;
      for (const r of ranked) {
        if (keep.size >= 2 && words + wordCount(r.s) > target && r.v < 99) continue;
        keep.add(r.i); words += wordCount(r.s);
      }
      const shorter = ordered.filter((_, i) => keep.has(i));
      if (shorter.length < ordered.length) note(`Kept the sentences with the most facts (about ${target} words).`);
      ordered = shorter;
    }
  }
  const out = ordered.join(" ").trim();
  const before = wordCount(source), after = wordCount(out);
  if (out === "" || (!isProtected(out) && !checkSuggestion(out))) return { state: "unavailable", message: "Elena could not improve this text safely. Edit it yourself or try again after changing it." };
  if (out.replace(/\s+/g, " ") === source.replace(/\s+/g, " ")) return { state: "unchanged", message: mode === "shorter" ? "It is already short and factual." : "Elena found nothing to improve." };
  return { state: "ready", mode, text: out, changes, beforeWords: before, afterWords: after, label: AI_SUGGESTION_LABEL };
}

// ---- Pricing strategy ----------------------------------------------------------------------------------------------------------------

export const PRICING_OPTION_IDS = ["competitive", "market", "aspirational"] as const;
export type PricingOptionId = (typeof PRICING_OPTION_IDS)[number];
export interface PricingOption { id: PricingOptionId; label: string; priceCents: number; tradeoff: string }
export const PRICING_NOTE =
  "Advisory only, from recent comparable results. It is not a valuation. Never quote a price below what you would accept: underquoting is unlawful in several states.";
export type Position = "below" | "within" | "above" | "none";

export type PricingAdvice =
  | {
    state: "ready"; lowCents: number; midCents: number; highCents: number; confidence: number;
    options: PricingOption[]; recommended: PricingOptionId; recommendedBecause: string;
    position: Position; positionNote: string; typicalDaysOnMarket?: number; note: string;
  }
  | { state: "unavailable"; message: string; positionNote: string; note: string };

/** Common search price steps: portals filter in steps, so a price just above a step is missed by searches up to that step. */
export function searchStep(tx: "sale" | "rent", cents: number): number {
  if (tx === "rent") return 5_000; // $50 a week
  return cents < 100_000_000 ? 5_000_000 : cents < 200_000_000 ? 10_000_000 : 25_000_000; // $50k, $100k, $250k
}

/** Moves a price that sits just above a search step to just under it (never above the original), else rounds it. */
export function nicePrice(tx: "sale" | "rent", cents: number, floorCents: number): number {
  const step = searchStep(tx, cents);
  const below = Math.floor(cents / step) * step;
  const justUnder = below - (tx === "rent" ? 500 : 100_000); // $5 under a $50 step; $1,000 under
  if (cents - below <= cents * 0.03 && justUnder >= floorCents) return justUnder;
  return Math.max(floorCents, roundTo(cents, tx === "rent" ? 500 : 100_000));
}

const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100);

export function pricingAdvice(f: Pick<AssistantFacts, "transactionType" | "priceCents">, estimate: PriceEstimate | undefined, profile: LearnedProfile = EMPTY_PROFILE): PricingAdvice {
  const tx = f.transactionType, rent = tx === "rent";
  const money = (c: number) => formatAud(c) + (rent ? " per week" : "");
  if (!estimate) {
    return {
      state: "unavailable", message: "Elena does not have enough recent comparable results for this property yet.",
      positionNote: "Check recent results for similar properties on your street and nearby, and price from those.", note: PRICING_NOTE
    };
  }
  const { lowCents: low, midCents: mid, highCents: high } = estimate;
  const options: PricingOption[] = [
    { id: "competitive", label: "Competitive", priceCents: nicePrice(tx, low + Math.round((mid - low) * 0.3), low),
      tradeoff: rent ? "Usually draws the most enquiries and a faster lease." : "Draws the most early interest and can lift the final result with competing offers." },
    { id: "market", label: "At market", priceCents: nicePrice(tx, mid, low),
      tradeoff: "In line with recent comparable results. A balanced start." },
    { id: "aspirational", label: "Aspirational", priceCents: Math.max(nicePrice(tx, high, low), nicePrice(tx, mid, low)),
      tradeoff: "Tests the top of the range. Expect fewer enquiries and be ready to adjust after the first weeks." }
  ];
  let recommended: PricingOptionId = "market";
  let because = estimate.confidence < 0.5 ? "Confidence is low, so the middle of the range is the safest start." : "It matches the middle of recent comparable results.";
  const most = PRICING_OPTION_IDS.map(id => ({ id, n: profile.pricing[id] ?? 0 })).sort((a, b) => b.n - a.n)[0]!;
  const total = PRICING_OPTION_IDS.reduce((n, id) => n + (profile.pricing[id] ?? 0), 0);
  if (total >= 3 && most.n / total >= 0.6 && estimate.confidence >= 0.5) {
    recommended = most.id;
    because = `You usually choose the ${most.id === "market" ? "at market" : most.id} option, and the range is reliable enough to follow that.`;
  }
  let position: Position = "none", positionNote = "Enter a price and Elena will show where it sits.";
  if (f.priceCents !== undefined) {
    if (f.priceCents < low) { position = "below"; positionNote = `Your price is ${pct(f.priceCents, mid) * -1}% below the middle of the range. It will attract interest but may leave value on the table.`; }
    else if (f.priceCents > high) { position = "above"; positionNote = `Your price is ${pct(f.priceCents, mid)}% above the middle of the range (${money(low)} to ${money(high)}). Expect fewer enquiries; be ready to review it after two weeks.`; }
    else { position = "within"; positionNote = `Your price is inside the range of ${money(low)} to ${money(high)}.`; }
  }
  const dom = estimate.comparables.map(c => c.daysOnMarket).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
  const typical = dom.length >= 3 ? dom[Math.floor(dom.length / 2)]! : undefined;
  return {
    state: "ready", lowCents: low, midCents: mid, highCents: high, confidence: estimate.confidence, options, recommended, recommendedBecause: because,
    position, positionNote, ...(typical !== undefined ? { typicalDaysOnMarket: typical } : {}), note: PRICING_NOTE
  };
}

// ---- Photo shot list ---------------------------------------------------------------------------------------------------------------

export interface PhotoShot { id: string; title: string; tip: string; essential: boolean }
export interface PhotoPlan { target: number; have?: number; missing: number; shots: PhotoShot[]; message: string }

export function photoPlan(f: Pick<AssistantFacts, "propertyType" | "amenities" | "bedrooms" | "photoCount">): PhotoPlan {
  const g = groupOf(f.propertyType);
  const am = new Set(f.amenities ?? []);
  const s = (id: string, title: string, tip: string, essential = false): PhotoShot => ({ id, title, tip, essential });
  let shots: PhotoShot[];
  if (g === "land") {
    shots = [s("land-front", "Street frontage", "Stand at the boundary and show the whole width.", true), s("land-aerial", "Aerial view", "A drone or high shot shows size and surroundings.", true),
      s("land-slope", "Slope and shape", "Show how level it is."), s("land-access", "Access and services", "Driveway, power and water points."), s("land-views", "Outlook", "Views and neighbours in daylight.")];
  } else if (g === "commercial") {
    shots = [s("com-front", "Frontage and signage", "Straight on, in daylight.", true), s("com-floor", "Main floor", "From the corner, wide angle, lights on.", true),
      s("com-fit", "Fit-out features", "Kitchenette, meeting rooms, loading dock."), s("com-parking", "Parking and access", "Entrances, car parks, truck access."), s("com-plan", "Floor plan", "Upload the plan as a photo.", true)];
  } else {
    shots = [
      s("hero", "Front of the property", "Shoot from the street in soft light, early morning or late afternoon, with the lawn mown and bins away.", true),
      s("living", "Main living area", "Stand in a corner for the widest view, curtains open and lights on.", true),
      s("kitchen", "Kitchen", "Clear the benchtops. One wide shot and one of the best feature.", true),
      s("main-bed", "Main bedroom", "Made bed, wide angle from the door, one shot of the wardrobe or ensuite.", true),
      s("bath", "Bathroom", "Towels folded, mirrors clean, shoot from the doorway.", true),
      s("bed-2", "Other bedrooms", "One photo each. A study or spare room can show how it is used."),
      ...(g === "unit" ? [s("balcony", "Balcony and outlook", "Shoot the view, not just the rail.", am.has("balcony"))] : [s("back", "Backyard or outdoor area", "Wide shot from the house showing how the space flows.", true)]),
      ...(am.has("pool") ? [s("pool", "Pool", "Clean water and bright sun, no pool toys.", true)] : []),
      ...(am.has("garage") ? [s("garage", "Garage or carport", "Show the space and any storage.")] : []),
      ...(am.has("solar") ? [s("solar", "Solar panels", "From the ground or a drone, to show the size.")] : []),
      s("laundry", "Laundry and storage", "Tidy, with the door open."),
      s("street", "Street or neighbourhood", "A park, shop or transport stop close by."),
      s("plan", "Floor plan", "A simple floor plan helps buyers who are comparing.")
    ];
  }
  const have = f.photoCount;
  const target = g === "land" ? 5 : g === "commercial" ? 8 : Math.max(10, Math.min(20, 8 + (f.bedrooms ?? 0)));
  const missing = Math.max(0, target - (have ?? 0));
  const message = have === undefined ? "Aim for about " + target + " photos. The first photo is what buyers see in search results, so start with the front of the property."
    : missing === 0 ? "You have a good set of photos. Check the first one: it is the one buyers see in search results."
    : `You have ${have} of about ${target} photos. The first photo is what buyers see in search results, so start with the front of the property.`;
  return { target, ...(have !== undefined ? { have } : {}), missing, shots, message };
}

// ---- Marketing angles --------------------------------------------------------------------------------------------------------------

export interface MarketingAngle { id: string; title: string; headline: string; why: string }

const ANGLES: { id: string; title: string; match: (t: ReadonlySet<string>, f: AssistantFacts) => number; make: (f: AssistantFacts) => string; why: string }[] = [
  { id: "lifestyle", title: "Outdoor lifestyle", why: "Outdoor features stood out in your description.",
    match: t => ["pool", "garden", "balcony", "entertaining"].filter(x => t.has(x)).length, make: f => `Outdoor living${f.suburb ? ` in ${f.suburb}` : ""}${carNote(f)}` },
  { id: "convenience", title: "Easy living and location", why: "Location or low-maintenance wording stood out.",
    match: t => ["near_transport", "near_amenities", "low_maintenance", "lift", "security"].filter(x => t.has(x)).length, make: f => `Close to what you need${f.suburb ? ` in ${f.suburb}` : ""}${carNote(f)}` },
  { id: "space", title: "Space and flexibility", why: "Several bedrooms, a study or storage stood out.",
    match: (t, f) => (f.bedrooms ?? 0) >= 4 ? 2 : ["study", "storage", "high_ceilings"].filter(x => t.has(x)).length, make: f => `Room to spread out${f.bedrooms ? ` with ${f.bedrooms} bedrooms` : ""}${carNote(f)}` },
  { id: "renovated", title: "Updated and ready", why: "Recent work or fresh finishes stood out.",
    match: t => ["renovated", "stone_kitchen", "timber_floors", "open_plan", "natural_light"].filter(x => t.has(x)).length, make: f => `Updated and ready to enjoy${f.suburb ? ` in ${f.suburb}` : ""}${carNote(f)}` },
  { id: "value", title: "Value for the area", why: "A clear, factual price story works when few features stand out.",
    match: () => 0.5, make: f => `${f.bedrooms ? `${f.bedrooms} bedroom ` : ""}${f.propertyType}${f.suburb ? ` in ${f.suburb}` : ""}${f.priceCents !== undefined ? `, ${formatAud(f.priceCents)}${f.transactionType === "rent" ? " a week" : ""}` : ""}` }
];
function carNote(f: AssistantFacts): string { return f.parking && f.parking > 0 ? `, with ${f.parking} car space${f.parking === 1 ? "" : "s"}` : ""; }

/** The two best angles for the property, each with a sample headline. Angles describe the property only. */
export function marketingAngles(f: AssistantFacts, tags: readonly TagSuggestion[], max = 2): MarketingAngle[] {
  const present = new Set([...tags.map(x => x.id), ...(f.amenities ?? [])]);
  return ANGLES.map(a => ({ a, n: a.match(present, f) })).filter(x => x.n > 0).sort((x, y) => y.n - x.n).slice(0, max)
    .map(({ a }) => ({ id: a.id, title: a.title, headline: a.make(f), why: a.why }));
}

// ---- Syndication (where to advertise) --------------------------------------------------------------------------------------

export type ChannelStatus = "ready" | "optional" | "needs_agent";
export interface ChannelAdvice { id: string; label: string; status: ChannelStatus; why: string }

export function syndicationPlan(f: AssistantFacts): ChannelAdvice[] {
  const rent = f.transactionType === "rent";
  const am = new Set(f.amenities ?? []);
  const out: ChannelAdvice[] = [
    { id: "platform", label: readBrand().name, status: "ready", why: "Your listing goes live here as soon as it is published and verified." },
    { id: "alerts", label: "Saved-search alerts", status: "ready", why: "Buyers who saved a matching search are told when you publish, so publish when photos and price are final." },
    { id: "share", label: "Share link", status: "optional", why: "Post the listing link in local community pages and send it to people who have asked about similar homes." }
  ];
  if (rent && (am.has("furnished") || /short[- ]stay|holiday|furnished/i.test(f.description ?? ""))) {
    out.push({ id: "short_stay", label: Object.values(PORTAL_LABELS).join(", "), status: "optional", why: "A furnished property can also be offered for short stays. Connect these in the syndication section of your listing." });
  }
  out.push({ id: "major_portals", label: "Major property portals", status: "needs_agent",
    why: rent ? "The big rental portals need an agency account. Appoint an agent if you want that reach." : "The big sales portals need an agency account. Appoint an agent if you want that reach and want to keep the sale price conversation with them." });
  return out;
}

// ---- Whole plan ------------------------------------------------------------------------------------------------------------------------

export interface AssistantPlan {
  questions: AssistantQuestion[];
  tips: Record<TipField, string>;
  tags: TagSuggestion[];
  pricing: PricingAdvice;
  photos: PhotoPlan;
  angles: MarketingAngle[];
  channels: ChannelAdvice[];
  learned: string[];
}

export function buildPlan(f: AssistantFacts, estimate: PriceEstimate | undefined, profile: LearnedProfile = EMPTY_PROFILE): AssistantPlan {
  const tags = suggestTags(f, profile);
  return {
    questions: clarifyingQuestions(f, profile), tips: fieldTips(f), tags, pricing: pricingAdvice(f, estimate, profile), photos: photoPlan(f),
    angles: marketingAngles(f, tags), channels: syndicationPlan(f), learned: describeLearning(profile)
  };
}

// ---- Learning from the author's choices ---------------------------------------------------------------------------------------

export const FEEDBACK_KINDS = ["tag", "question", "rewrite", "pricing"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_ACTIONS = ["accepted", "dismissed", "edited", "answered", "chosen"] as const;
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number];

/**
 * One thing the author did with a suggestion. Only fixed vocabulary keys and a number are stored, never the text the author wrote,
 * so the record holds no personal data and cannot be used to train a model without consent (see ai-learning.ts).
 * For rewrite "edited": deltaPct is how much longer (+) or shorter (-) the final text was than Elena's, in percent.
 */
export interface FeedbackEvent { kind: FeedbackKind; key: string; action: FeedbackAction; deltaPct?: number }

const VALID: Record<FeedbackKind, { keys: readonly string[]; actions: readonly FeedbackAction[] }> = {
  tag: { keys: [...AMENITIES, ...HIGHLIGHTS.map(h => h.id)], actions: ["accepted", "dismissed"] },
  question: { keys: QUESTION_IDS, actions: ["answered", "dismissed"] },
  rewrite: { keys: REWRITE_MODES, actions: ["accepted", "dismissed", "edited"] },
  pricing: { keys: PRICING_OPTION_IDS, actions: ["chosen"] }
};
export const MAX_FEEDBACK_BATCH = 20;

export function parseFeedback(raw: unknown): { ok: true; events: FeedbackEvent[] } | { ok: false; error: string } {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0 || list.length > MAX_FEEDBACK_BATCH) return { ok: false, error: `Send between 1 and ${MAX_FEEDBACK_BATCH} events.` };
  const events: FeedbackEvent[] = [];
  for (const x of list) {
    const e = (x !== null && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const kind = e["kind"], key = e["key"], action = e["action"];
    if (typeof kind !== "string" || !(FEEDBACK_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "Unknown feedback kind." };
    const v = VALID[kind as FeedbackKind];
    if (typeof key !== "string" || !v.keys.includes(key)) return { ok: false, error: "Unknown feedback key." };
    if (typeof action !== "string" || !(v.actions as readonly string[]).includes(action)) return { ok: false, error: "Unknown feedback action." };
    const ev: FeedbackEvent = { kind: kind as FeedbackKind, key, action: action as FeedbackAction };
    if (e["deltaPct"] !== undefined) {
      const d = e["deltaPct"];
      if (kind !== "rewrite" || action !== "edited" || typeof d !== "number" || !Number.isFinite(d)) return { ok: false, error: "deltaPct is only for edited rewrites." };
      ev.deltaPct = Math.max(-100, Math.min(300, Math.round(d)));
    }
    events.push(ev);
  }
  return { ok: true, events };
}

export interface LearnedProfile {
  tags: Record<string, { accepted: number; dismissed: number }>;
  questions: Record<string, { answered: number; dismissed: number }>;
  rewrite: Record<string, { accepted: number; dismissed: number; edited: number; deltas: number[] }>;
  pricing: Record<string, number>;
}
export const EMPTY_PROFILE: LearnedProfile = { tags: {}, questions: {}, rewrite: {}, pricing: {} };

export function learnFrom(events: readonly FeedbackEvent[]): LearnedProfile {
  const p: LearnedProfile = { tags: {}, questions: {}, rewrite: {}, pricing: {} };
  for (const e of events) {
    if (e.kind === "tag") {
      const s = (p.tags[e.key] ??= { accepted: 0, dismissed: 0 });
      if (e.action === "accepted") s.accepted++; else if (e.action === "dismissed") s.dismissed++;
    } else if (e.kind === "question") {
      const s = (p.questions[e.key] ??= { answered: 0, dismissed: 0 });
      if (e.action === "answered") s.answered++; else if (e.action === "dismissed") s.dismissed++;
    } else if (e.kind === "rewrite") {
      const s = (p.rewrite[e.key] ??= { accepted: 0, dismissed: 0, edited: 0, deltas: [] });
      if (e.action === "accepted") s.accepted++; else if (e.action === "dismissed") s.dismissed++;
      else if (e.action === "edited") { s.edited++; if (e.deltaPct !== undefined) s.deltas.push(e.deltaPct); }
    } else if (e.kind === "pricing") {
      p.pricing[e.key] = (p.pricing[e.key] ?? 0) + 1;
    }
  }
  return p;
}

const median = (xs: readonly number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!; };

/** Target length for "shorter": moves toward what the author keeps editing the result to (needs three edits to move). */
export function shorterTarget(profile: LearnedProfile): number {
  const d = profile.rewrite["shorter"]?.deltas ?? [];
  if (d.length < 3) return SHORTER_DEFAULT_WORDS;
  const m = median(d);
  const adj = m > 10 ? 1 + Math.min(m, 60) / 100 : m < -10 ? 1 + Math.max(m, -40) / 100 : 1;
  return Math.max(50, Math.min(140, Math.round(SHORTER_DEFAULT_WORDS * adj)));
}

/** The rewrite mode to preselect: the one the author accepts more often, once they have tried both enough. */
export function preferredRewriteMode(profile: LearnedProfile): RewriteMode {
  const rate = (m: RewriteMode) => { const s = profile.rewrite[m]; const n = s ? s.accepted + s.edited + s.dismissed : 0; return n >= 3 && s ? (s.accepted + s.edited) / n : -1; };
  return rate("shorter") > rate("better") ? "shorter" : "better";
}

/** Plain sentences telling the author what Elena has learned, so it is never a black box. */
export function describeLearning(p: LearnedProfile): string[] {
  const out: string[] = [];
  const liked = Object.entries(p.tags).filter(([, s]) => s.accepted >= 2 && s.accepted > s.dismissed).map(([k]) => k);
  const skipped = Object.entries(p.tags).filter(([, s]) => s.dismissed >= 2 && s.dismissed > s.accepted).map(([k]) => k);
  const label = (k: string) => (AMENITY_LABELS as Record<string, string>)[k] ?? HIGHLIGHTS.find(h => h.id === k)?.label ?? k;
  if (liked.length) out.push(`You often keep these tags: ${liked.map(label).join(", ")}.`);
  if (skipped.length) out.push(`You often skip these tags, so Elena shows them less: ${skipped.map(label).join(", ")}.`);
  const skippedQ = Object.entries(p.questions).filter(([, s]) => s.dismissed >= 2).map(([k]) => k);
  if (skippedQ.length) out.push(`Elena asks less about: ${skippedQ.join(", ")}.`);
  if (shorterTarget(p) !== SHORTER_DEFAULT_WORDS) out.push(`Shorter descriptions now aim for about ${shorterTarget(p)} words, from how you edit them.`);
  if (Object.keys(p.rewrite).length > 0 && preferredRewriteMode(p) === "shorter") out.push("You tend to prefer shorter descriptions.");
  const total = PRICING_OPTION_IDS.reduce((n, id) => n + (p.pricing[id] ?? 0), 0);
  if (total >= 3) {
    const top = [...PRICING_OPTION_IDS].sort((a, b) => (p.pricing[b] ?? 0) - (p.pricing[a] ?? 0))[0]!;
    out.push(`You usually choose the ${top === "market" ? "at market" : top} price option.`);
  }
  return out;
}
