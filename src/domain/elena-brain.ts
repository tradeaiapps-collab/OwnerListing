import { searchKnowledge, KNOWLEDGE_NOTE, type KnowledgeEntry } from "./elena-knowledge";
import { analyseInvestment, suburbProfile, type InvestmentAnalysis, type SuburbProfile } from "./elena-analysts";
import { extendedAnswer, type ExtendedBundle } from "./market-forecast";
import type { IntelBundle } from "./property-intelligence";
import { formatPrice } from "./listing-details";

/**
 * Elena's brain: routes one question to the knowledge base, the suburb analyst, the market analyst or the investment analyzer,
 * using what the app already knows about the person's situation (page, role, state, listing, search, project).
 * She explains and informs; she declines "should I" decisions and says so. Pure: all data is passed in, nothing is stored here.
 */

export const BRAIN_VERSION = "brain-v1";

export type BrainIntent = "advice_declined" | "knowledge" | "suburb" | "market" | "investment" | "needs_suburb" | "needs_numbers" | "unknown";

/** What the app knows. Built server-side from the person's own records only. */
export interface ElenaAppContext {
  page?: string | undefined;
  role?: "buyer" | "owner" | "agent" | "investor" | "other" | undefined;
  state?: string | undefined;
  suburb?: string | undefined;
  postcode?: string | undefined;
  listing?: { id: string; suburb?: string | undefined; postcode?: string | undefined; propertyType?: string | undefined; priceCents?: number | undefined; weeklyRentCents?: number | undefined; transactionType?: "sale" | "rent" | undefined } | undefined;
  buyerPrefs?: { suburbs?: string[] | undefined; maxBudgetCents?: number | undefined; bedrooms?: number | undefined } | undefined;
  project?: { id: string; title: string; suburb?: string | undefined; targetCents?: number | undefined } | undefined;
}

export interface BrainData {
  bundle?: IntelBundle | undefined;
  extended?: ExtendedBundle | undefined;
  facts?: Parameters<typeof suburbProfile>[0]["facts"];
}

export interface BrainAnswer {
  version: string;
  intent: BrainIntent;
  /** Stable key used as the learning-loop suggestion type. */
  type: string;
  text: string;
  suggestions: string[];
  /** Where the answer came from, shown to the person. */
  sources: string[];
  suburb?: SuburbProfile | undefined;
  investment?: InvestmentAnalysis | undefined;
  knowledge?: { id: string; title: string }[] | undefined;
}

const ASK_ADVICE = /\b(should\s+(i|we)|is\s+it\s+(worth|a\s+good)|good\s+(investment|buy|deal|time\s+to)|buy\s+now|sell\s+now|guarantee\w*|will\s+(it|prices?|the\s+market)\s+(go|rise|fall|drop|crash)|safe\s+bet|tell\s+me\s+what\s+to\s+do)\b/;
const SUBURB = /\b(suburb|neighbou?rhood|area|schools?|crime|safe(ty)?|transport|train|amenit\w+|demographics?|what('?s|\s+is)\s+it\s+like|living\s+in|moving\s+to)\b/;
const MARKET = /\b(market|prices?|trend\w*|forecast\w*|comparable\w*|comps|sold|recent\s+sales|median|days\s+on\s+market|demand|heating|cooling|growth|values?|worth|valuation)\b/;
const INVEST = /\b(invest\w*|roi|return\s+on|yield|cash\s*flow|negative(ly)?\s+geared|positive(ly)?\s+geared|break\s*even|stress\s+test|portfolio|diversif\w+|repayments?)\b/;

export const BRAIN_SUGGESTIONS = ["Tell me about this suburb", "How are prices moving here?", "What does gross yield mean?", "How do I negotiate an offer?"];

const declined = (): BrainAnswer => ({
  version: BRAIN_VERSION, intent: "advice_declined", type: "advice_declined",
  text: "I can't tell you whether to buy, sell or hold, because that depends on your finances and goals and needs a licensed professional. I can show you the facts that bear on it: recent sales, trends, rental yield, the costs, and the risks. Which would help?",
  suggestions: ["How are prices moving here?", "What are the risks of investing?", "What would the repayments look like?"], sources: []
});

/** Words after "in", "at", "around" or "near" that look like a suburb name; used only when the app gave no suburb. */
export function suburbFromText(q: string): string | undefined {
  const m = /\b(?:in|at|around|near|about|for)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\b/.exec(q.slice(0, 500));
  return m?.[1]?.trim();
}

/** The suburb to analyse: the question wins, then the open listing, then the project, then the buyer's search. */
export function resolveSuburb(question: string, ctx: ElenaAppContext): { suburb: string; postcode?: string | undefined; from: "question" | "context" } | undefined {
  const fromText = suburbFromText(question);
  if (fromText) return { suburb: fromText, from: "question" };
  const s = ctx.suburb ?? ctx.listing?.suburb ?? ctx.project?.suburb ?? ctx.buyerPrefs?.suburbs?.[0];
  if (!s) return undefined;
  return { suburb: s, postcode: ctx.postcode ?? ctx.listing?.postcode, from: "context" };
}

/** Pulls dollar amounts and percentages out of a question: "$850,000 rent $600 a week at 6%". */
export function numbersFromText(q: string): { priceCents?: number; weeklyRentCents?: number; ratePercent?: number } {
  const t = q.toLowerCase().replace(/,/g, "");
  const out: { priceCents?: number; weeklyRentCents?: number; ratePercent?: number } = {};
  const money = (s: string): number | undefined => {
    const m = /\$?\s*(\d+(?:\.\d+)?)\s*(k|m)?/.exec(s);
    if (!m) return undefined;
    const n = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1000 : 1);
    return Number.isFinite(n) ? Math.round(n * 100) : undefined;
  };
  const rent = /\$?\s*(\d+(?:\.\d+)?\s*(?:k|m)?)\s*(?:\/|a|per)\s*(?:wk|week)/.exec(t) ?? /rent(?:ing|ed)?\s*(?:of|for|at)?\s*\$?\s*(\d+(?:\.\d+)?\s*(?:k|m)?)/.exec(t);
  if (rent?.[1]) { const v = money(rent[1]); if (v !== undefined && v > 0) out.weeklyRentCents = v; }
  const stripped = rent ? t.replace(rent[0], " ") : t;
  for (const m of stripped.matchAll(/\$?\s*(\d+(?:\.\d+)?\s*(?:k|m)?)\b/g)) {
    const raw = m[1] ?? "";
    if (stripped[(m.index ?? 0) + m[0].length] === "%") continue;
    const v = money(raw);
    if (v !== undefined && v >= 5_000_000) { out.priceCents = v; break; }
  }
  const rate = /(\d+(?:\.\d+)?)\s*%/.exec(t);
  if (rate && Number(rate[1]) > 0 && Number(rate[1]) <= 25) out.ratePercent = Number(rate[1]);
  return out;
}

const knowledgeText = (hits: { entry: KnowledgeEntry }[]): string => hits.map((h) => h.entry.answer).slice(0, 2).join("\n\n");

export function answerQuestion(question: string, ctx: ElenaAppContext, data: BrainData = {}): BrainAnswer {
  const q = question.normalize("NFKC").slice(0, 500);
  const t = q.toLowerCase();
  if (t.trim() === "") return { version: BRAIN_VERSION, intent: "unknown", type: "unknown", text: "Ask me about a property, a suburb, the market, an investment or how buying and selling works.", suggestions: BRAIN_SUGGESTIONS, sources: [] };
  if (ASK_ADVICE.test(t)) return declined();

  // Investment maths when numbers are present, or the listing in context has them.
  if (INVEST.test(t) && /\b(yield|cash\s*flow|break\s*even|stress|repayments?|roi|return)\b/.test(t)) {
    const n = numbersFromText(q);
    const price = n.priceCents ?? (ctx.listing?.transactionType === "sale" ? ctx.listing.priceCents : undefined);
    const rent = n.weeklyRentCents ?? ctx.listing?.weeklyRentCents;
    const a = price !== undefined && rent !== undefined ? analyseInvestment({ priceCents: price, weeklyRentCents: rent, ...(n.ratePercent !== undefined ? { ratePercent: n.ratePercent } : {}) }) : undefined;
    if (a) {
      const wk = (c: number) => `${c < 0 ? "-" : ""}${formatPrice(Math.abs(c), "rent")}`;
      const text = [
        `On ${formatPrice(price!, "sale")} with ${formatPrice(rent!, "rent")} rent: gross yield ${a.grossYieldPercent}%, net yield ${a.netYieldPercent}% after costs.`,
        `Cash flow is about ${wk(a.weeklyCashFlowCents)}; it breaks even at ${formatPrice(a.breakEvenWeeklyRentCents, "rent")} rent. At 2 points higher interest it would be ${wk(a.rateStress[1]!.weeklyCashFlowCents)}.`,
        a.risks.length ? `Things to weigh: ${a.risks.join(" ")}` : "",
        `Assumed: ${a.assumed.join(", ") || "nothing"}. ${a.note}`
      ].filter(Boolean).join(" ");
      return { version: BRAIN_VERSION, intent: "investment", type: "investment_analysis", text, suggestions: ["What are the risks of investing?", "What does net yield mean?", "How do I diversify?"], sources: ["Investment analyzer"], investment: a };
    }
    if (n.priceCents === undefined || n.weeklyRentCents === undefined) {
      return { version: BRAIN_VERSION, intent: "needs_numbers", type: "needs_numbers", text: "To work out yield and cash flow I need the purchase price and the weekly rent, for example: \"yield on $850,000 with rent $600 a week at 6%\". I'll assume costs and tell you which.", suggestions: ["What does gross yield mean?", "What are the risks of investing?"], sources: [] };
    }
  }

  const topMarket = MARKET.test(t) && !/\b(negotiat\w+|offer\w*|stamp duty)\b/.test(t);
  const topSuburb = SUBURB.test(t);
  if (topSuburb || topMarket) {
    const place = resolveSuburb(q, ctx);
    if (!place && !data.bundle) {
      const k = searchKnowledge(q);
      if (k.length) return knowledgeAnswer(k);
      return { version: BRAIN_VERSION, intent: "needs_suburb", type: "needs_suburb", text: "Which suburb do you mean? Tell me the suburb or open a listing and I'll use its location.", suggestions: ["Tell me about Bondi", "How are prices moving in Parramatta?"], sources: [] };
    }
    if (data.bundle && data.extended) {
      const b = data.bundle, x = data.extended;
      if (topSuburb && !/\b(price|trend|forecast|demand)\b/.test(t)) {
        const profile = suburbProfile({
          suburb: place?.suburb ?? b.query.suburb ?? "this area", postcode: place?.postcode ?? b.query.postcode, market: b.market, trend: b.trend,
          forecast: x.forecast, score: x.score, demand: x.demand, facts: data.facts
        });
        const body = [profile.headline, profile.strengths.length ? `Going for it: ${profile.strengths.join(" ")}` : "", profile.watchPoints.length ? `To watch: ${profile.watchPoints.join(" ")}` : "", profile.gaps.length ? `Not covered yet: ${profile.gaps.join(" ")}` : ""].filter(Boolean).join("\n\n");
        return { version: BRAIN_VERSION, intent: "suburb", type: "suburb_profile", text: body, suggestions: ["How are prices moving here?", "How is buyer demand?", "How strong are the area fundamentals?"], sources: ["Platform sales and buyer activity", "Suburb analyst"], suburb: profile };
      }
      const a = extendedAnswer(b, x, q);
      return { version: BRAIN_VERSION, intent: "market", type: `market_${a.topic}`, text: a.text, suggestions: a.suggestions, sources: ["Platform sales and buyer activity", "Market analyst"] };
    }
    // Wants market or suburb data that the caller did not load: ask for it by name rather than guess.
    return { version: BRAIN_VERSION, intent: topSuburb ? "suburb" : "market", type: "needs_data", text: `I can look at ${place?.suburb ?? "that area"} but I need its sales data loaded first. Try again in a moment.`, suggestions: BRAIN_SUGGESTIONS, sources: [] };
  }

  const hits = searchKnowledge(q);
  if (hits.length) return knowledgeAnswer(hits);
  return { version: BRAIN_VERSION, intent: "unknown", type: "unknown", text: "I'm not sure about that one yet. I can explain property types and terms, buying, selling and negotiating, rentals and investing, and look at suburb and market figures.", suggestions: BRAIN_SUGGESTIONS, sources: [] };
}

function knowledgeAnswer(hits: ReturnType<typeof searchKnowledge>): BrainAnswer {
  const first = hits[0]!.entry;
  return {
    version: BRAIN_VERSION, intent: "knowledge", type: `knowledge_${first.topic}`,
    text: `${knowledgeText(hits)}\n\n${KNOWLEDGE_NOTE}`,
    suggestions: BRAIN_SUGGESTIONS.filter((s) => !s.toLowerCase().includes(first.title.toLowerCase())).slice(0, 3),
    sources: ["Elena knowledge base"], knowledge: hits.map((h) => ({ id: h.entry.id, title: h.entry.title }))
  };
}

/** Whether a question needs the market/suburb data loaded (so the route skips the cost for plain knowledge questions). */
export function needsMarketData(question: string): boolean {
  const t = question.toLowerCase();
  if (ASK_ADVICE.test(t)) return false;
  return (SUBURB.test(t) || MARKET.test(t)) && !/\b(negotiat\w+|offer\w*|stamp duty)\b/.test(t);
}
