import { AMENITIES, AMENITY_LABELS, formatPrice, type Amenity } from "./listing-details";
import { interpretSearch } from "./search-assist";

/**
 * Elena as a buyer advisor: the questions an agent asks on a first call (buy or rent, budget, type, bedrooms, where, must-haves),
 * turned into search filters. Pure and rule based, so it works with the AI engine off. Parameters use the /api/listings names
 * (prices in cents), so they can go straight into the search form. She never values a property or says what someone can afford.
 */
export type AdvisorStep = "intent" | "budget" | "type" | "beds" | "where" | "extras" | "done";
export interface AdvisorState { step: AdvisorStep; params: Record<string, string>; /** Steps already asked and answered or skipped. */ asked: AdvisorStep[] }
export interface AdvisorTurn { state: AdvisorState; reply: string }

export const ADVISOR_NOTE = "General information only. Not a valuation or finance advice. Check what you can borrow with a lender.";
export const ADVISOR_START: AdvisorState = { step: "intent", params: {}, asked: [] };

const ORDER: AdvisorStep[] = ["intent", "budget", "type", "beds", "where", "extras"];
const SKIP = /\b(skip|any|anything|no preference|not sure|don'?t mind|do not mind|flexible|no limit|no budget|open|either|whatever)\b/;
const NO = /^(no|nope|nah|nothing|none|that'?s all|all good|not really)\b/;
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

export const openingMessage = (name: string) =>
  `Hi, I'm ${name}. I'll ask a few questions, the same as an agent would on a call, so we can narrow the search. Are you looking to buy or to rent?`;

export function questionFor(step: AdvisorStep, tx: string | undefined, retry = false): string {
  const pre = retry ? "Sorry, I didn't catch that. " : "";
  switch (step) {
    case "intent": return `${pre}Are you looking to buy or to rent?`;
    case "budget": return tx === "rent" ? `${pre}What's your weekly rent budget? For example $650 a week, or say "any".` : `${pre}What's your budget? A range like 600k to 900k is fine, or say "any".`;
    case "type": return `${pre}What type of property are you after? A house, apartment, townhouse or land? Or say "any".`;
    case "beds": return `${pre}How many bedrooms do you need? A number is fine, or say "any".`;
    case "where": return `${pre}Where would you like to live? Give me a suburb, a postcode or a state, or say "anywhere".`;
    case "extras": return `${pre}Anything else you must have, like a pool, garage, air conditioning, pet friendly or a garden? Or say "no".`;
    default: return "";
  }
}

/** Plain words for the filters collected so far. */
export function describeParams(p: Record<string, string>): string[] {
  const tx = p["transactionType"] === "rent" ? "rent" : "sale";
  const f = (c: string) => formatPrice(Number(c), tx);
  const out: string[] = [];
  if (p["transactionType"]) out.push(tx === "rent" ? "To rent" : "To buy");
  if (p["minPriceCents"] && p["maxPriceCents"]) out.push(`${f(p["minPriceCents"])} to ${f(p["maxPriceCents"])}`);
  else if (p["maxPriceCents"]) out.push(`up to ${f(p["maxPriceCents"])}`);
  else if (p["minPriceCents"]) out.push(`from ${f(p["minPriceCents"])}`);
  if (p["propertyType"]) out.push(p["propertyType"].charAt(0).toUpperCase() + p["propertyType"].slice(1));
  if (p["minBedrooms"]) out.push(`${p["minBedrooms"]}+ bedrooms`);
  if (p["suburb"]) out.push(p["suburb"]);
  if (p["postcode"]) out.push(`Postcode ${p["postcode"]}`);
  if (p["jurisdiction"]) out.push(p["jurisdiction"]);
  for (const a of (p["amenities"] ?? "").split(",")) if ((AMENITIES as readonly string[]).includes(a)) out.push(AMENITY_LABELS[a as Amenity]);
  return out;
}

const toCents = (num: string, unit: string | undefined): number | undefined => {
  const n = Number(num.replace(/,/g, ""));
  const mult = unit === "k" || unit === "thousand" ? 1_000 : unit ? 1_000_000 : 1;
  const c = Math.round(n * mult * 100);
  return Number.isFinite(c) && c > 0 && c <= 100_000_000_000 ? c : undefined;
};

function parseBudget(text: string, tx: string | undefined): { min?: number; max?: number } | null {
  const f = interpretSearch(text).params;
  const min = f["minPriceCents"] ? Number(f["minPriceCents"]) : undefined;
  const max = f["maxPriceCents"] ? Number(f["maxPriceCents"]) : undefined;
  if (min !== undefined || max !== undefined) return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  // A bare number: dollars a week for a rental, thousands for a sale under 10,000 ("800" means $800k).
  const m = /(\d[\d,]*(?:\.\d+)?)\s*(k|m|mil|million|thousand)?/.exec(text.toLowerCase());
  if (!m) return null;
  const unit = m[2] ?? (tx !== "rent" && Number(m[1]!.replace(/,/g, "")) < 10_000 ? "k" : undefined);
  const c = toCents(m[1]!, unit);
  return c === undefined ? null : { max: c };
}

function parseBeds(text: string): number | null {
  const t = text.toLowerCase();
  const m = /\b(\d{1,2})\b/.exec(t);
  const n = m ? Number(m[1]) : Object.entries(WORDS).find(([w]) => new RegExp(`\\b${w}\\b`).test(t))?.[1];
  return n !== undefined && n >= 1 && n <= 20 ? Math.min(5, n) : null;
}

function parseWhere(text: string): Record<string, string> | null {
  const f = interpretSearch(text).params;
  const out: Record<string, string> = {};
  if (f["jurisdiction"]) out["jurisdiction"] = f["jurisdiction"];
  if (f["postcode"]) out["postcode"] = f["postcode"];
  else if (f["suburb"]) out["suburb"] = f["suburb"];
  else if (!out["jurisdiction"]) {
    const first = text.split(/,| and | or /i)[0]!.trim().replace(/^(?:in|near|around|the)\s+/i, "");
    if (/^[a-z][a-z' -]{1,39}$/i.test(first)) out["suburb"] = first.replace(/\b[a-z]/g, c => c.toUpperCase());
    else if (/^\d{4}$/.test(first)) out["postcode"] = first;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Whether a step still needs asking: not asked yet, and nothing the buyer already said fills it. */
function filled(step: AdvisorStep, p: Record<string, string>): boolean {
  switch (step) {
    case "intent": return Boolean(p["transactionType"]);
    case "budget": return Boolean(p["minPriceCents"] || p["maxPriceCents"]);
    case "type": return Boolean(p["propertyType"]);
    case "beds": return Boolean(p["minBedrooms"]);
    case "where": return Boolean(p["jurisdiction"] || p["suburb"] || p["postcode"]);
    default: return false;
  }
}
const nextStep = (asked: AdvisorStep[], p: Record<string, string>): AdvisorStep => ORDER.find(s => !asked.includes(s) && !filled(s, p)) ?? "done";

export function summaryMessage(p: Record<string, string>): string {
  const d = describeParams(p);
  return d.length > 0
    ? `Thanks, that's enough to start. I've set your search to: ${d.join(", ")}. You can change any answer by telling me, or use the form.`
    : "Thanks. I've left the search open so you can see everything. Tell me anything you'd like to narrow it by.";
}

/** One buyer answer in, one reply out. Anything extra in the answer ("3 bed house in Paddington") is picked up too, so she never asks twice. */
export function advance(state: AdvisorState, raw: string): AdvisorTurn {
  const text = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!text) return { state, reply: questionFor(state.step, state.params["transactionType"], true) };
  const p = { ...state.params };
  const lower = text.toLowerCase();
  const found = interpretSearch(text).params;
  const asked = [...state.asked];
  let ok = true;

  // Buy or rent comes from the words only, never from guessing at a price, unless the buyer is on that step.
  if (!p["transactionType"]) {
    if (/\b(?:rent|rental|renting|lease)\b/.test(lower)) p["transactionType"] = "rent";
    else if (/\b(?:buy|buying|purchase|sale|own)\b/.test(lower)) p["transactionType"] = "sale";
    else if (state.step === "intent" && found["transactionType"]) p["transactionType"] = found["transactionType"];
  }
  if (state.step === "intent") {
    ok = Boolean(p["transactionType"]);
    if (ok) asked.push("intent");
  }
  const tx = p["transactionType"];

  // Facts mentioned out of order are kept (not for the step being answered, which has its own reader below).
  const take = (key: string, value: string | undefined) => { if (value !== undefined && !p[key]) p[key] = value; };
  if (state.step !== "type") take("propertyType", found["propertyType"]);
  if (state.step !== "where") { take("jurisdiction", found["jurisdiction"]); take("suburb", found["suburb"]); take("postcode", found["postcode"]); }
  if (state.step !== "beds") take("minBedrooms", found["minBedrooms"]);
  if (state.step !== "extras") take("amenities", found["amenities"]);
  if (state.step !== "budget" && tx) { take("minPriceCents", found["minPriceCents"]); take("maxPriceCents", found["maxPriceCents"]); }

  const skipped = SKIP.test(lower) || NO.test(lower);
  switch (state.step) {
    case "budget": {
      const b = skipped ? {} : parseBudget(text, tx);
      ok = b !== null;
      if (ok) { delete p["minPriceCents"]; delete p["maxPriceCents"]; if (b!.min !== undefined) p["minPriceCents"] = String(b!.min); if (b!.max !== undefined) p["maxPriceCents"] = String(b!.max); asked.push("budget"); }
      break;
    }
    case "type": {
      if (found["propertyType"]) { p["propertyType"] = found["propertyType"]; asked.push("type"); } else if (skipped) asked.push("type"); else ok = false;
      break;
    }
    case "beds": {
      const n = skipped ? null : parseBeds(text);
      if (n !== null) { p["minBedrooms"] = String(n); asked.push("beds"); } else if (skipped) asked.push("beds"); else ok = false;
      break;
    }
    case "where": {
      const w = skipped ? null : parseWhere(text);
      if (w) { for (const k of ["jurisdiction", "suburb", "postcode"]) delete p[k]; Object.assign(p, w); asked.push("where"); } else if (skipped || /anywhere/.test(lower)) asked.push("where"); else ok = false;
      break;
    }
    case "extras": {
      if (found["amenities"]) p["amenities"] = found["amenities"];
      if (found["amenities"] || skipped) asked.push("extras"); else ok = false;
      break;
    }
    default: break;
  }

  if (state.step === "done") {
    // After the questions, anything the buyer says refines the search.
    const changed = Object.keys(found).filter(k => k !== "transactionType" || !p[k]);
    for (const k of changed) p[k] = found[k]!;
    const d = describeParams(p);
    return { state: { ...state, params: p }, reply: changed.length > 0 ? `Done. Your search is now: ${d.join(", ")}.` : "I didn't find a filter in that. You can say things like \"under 700k\", \"with a pool\" or \"in Brisbane\"." };
  }
  if (!ok) return { state: { ...state, params: p, asked }, reply: questionFor(state.step, tx, true) };
  const next = nextStep(asked, p);
  if (next === "done") return { state: { step: "done", params: p, asked }, reply: summaryMessage(p) };
  return { state: { step: next, params: p, asked }, reply: `${ackFor(state.step, p)} ${questionFor(next, tx)}`.trim() };
}

function ackFor(step: AdvisorStep, p: Record<string, string>): string {
  const d = describeParams(p);
  const pick = (re: RegExp) => d.find(x => re.test(x));
  switch (step) {
    case "intent": return p["transactionType"] === "rent" ? "Great, a rental." : "Great, buying.";
    case "budget": return pick(/^(up to|from|\$)/) ? `Got it, ${pick(/^(up to|from|\$)/)}.` : "No problem, I'll keep the price open.";
    case "type": return p["propertyType"] ? `${pick(/^[A-Z][a-z]+$/) ?? "That type"}, noted.` : "Any type, no problem.";
    case "beds": return p["minBedrooms"] ? `${p["minBedrooms"]}+ bedrooms, noted.` : "Any number of bedrooms, no problem.";
    case "where": return pick(/^(Postcode|[A-Z])/) && (p["suburb"] || p["postcode"] || p["jurisdiction"]) ? `${p["suburb"] ?? (p["postcode"] ? `Postcode ${p["postcode"]}` : p["jurisdiction"])}, good.` : "I'll look everywhere.";
    default: return "";
  }
}

/** Raise the top of the budget by 15%, for when nothing matches. Null when there is no budget to raise. */
export function widenBudget(p: Record<string, string>): Record<string, string> | null {
  const max = Number(p["maxPriceCents"]);
  if (!Number.isFinite(max) || max <= 0) return null;
  const step = p["transactionType"] === "rent" ? 5_000 : 5_000_000; // round to $50 a week or $50,000
  return { ...p, maxPriceCents: String(Math.ceil((max * 1.15) / step) * step) };
}
