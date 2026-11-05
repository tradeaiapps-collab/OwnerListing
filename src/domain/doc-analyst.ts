/**
 * Elena as document analyst: reads the text of an inspection report, contract, market report or email and returns a summary,
 * key facts, flagged risks and opportunities, action items and (for inspections) an indicative repair cost range.
 * Pure functions, no I/O. Rule based and self-hosted (CLAUDE.md: no external AI account): the same text always gives the same
 * answer, every flag quotes the words it came from, and nothing here decides anything for the user. Document text is data:
 * it is never executed or followed as instructions.
 */

export const ENGINE_VERSION = "doc-analyst-1";
export const MAX_TEXT_CHARS = 400_000;
export const DISCLAIMER = "Elena is an AI assistant, not a solicitor, building inspector or licensed agent. This is a reading aid. Check anything important with a qualified professional before you act.";

export type DocClass = "inspection" | "contract" | "market" | "email" | "unknown";
export const DOC_CLASSES: readonly DocClass[] = ["inspection", "contract", "market", "email", "unknown"];
export type Severity = "high" | "medium" | "low";
export type Rating = "red" | "amber" | "green";
export type FactKind = "money" | "date" | "percent" | "days" | "number" | "text";

export interface Fact { label: string; value: string; kind: FactKind; cents?: number; num?: number; excerpt?: string }
export interface Finding { id: string; severity: Severity; title: string; why: string; action: string; excerpt: string; costLowCents?: number; costHighCents?: number }
export interface Opportunity { id: string; title: string; why: string; excerpt: string }
export interface ActionItem { text: string; priority: Severity; due?: string }
export interface CostEstimate { lowCents: number; highCents: number; basis: "stated" | "indicative" | "mixed" }

export interface Analysis {
  engine: string;
  docClass: DocClass;
  headline: string;
  rating: Rating;
  executiveSummary: string;
  keyPoints: string[];
  facts: Fact[];
  risks: Finding[];
  opportunities: Opportunity[];
  actionItems: ActionItem[];
  cost?: CostEstimate;
  /** Honest limits of this reading (short text, unknown type, nothing found). */
  notes: string[];
  disclaimer: string;
  wordCount: number;
}

// ---- Text helpers ---------------------------------------------------------------------------------------------------------------

/** Strips control characters and tidies whitespace. Newlines are kept (they mark lines and paragraphs). */
export function cleanText(raw: string): string {
  return raw.slice(0, MAX_TEXT_CHARS * 2)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

const STOP = new Set("a an and are as at be been but by can could did do does for from had has have he her his i if in into is it its may me more most must my no not of on or our shall she should so such that the their them then there these they this to us was we were what when where which who will with would you your".split(" "));

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=["'(A-Z0-9$])|\n+/).map(s => s.replace(/\s+/g, " ").trim()).filter(s => s.length >= 12 && /[a-z]/i.test(s));
}

/** Clipped single-line quote for an excerpt. */
export const quote = (s: string, max = 220): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[a-z][a-z'-]{2,}/g)?.filter(w => !STOP.has(w)) ?? [];

/** "$1,250,000", "$1.2m", "$450k", "AUD 1,200", "1200 dollars" to cents. Undefined when not a sensible amount. */
export function moneyToCents(s: string): number | undefined {
  const m = /(?:\$|aud\s?)\s?([\d]{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?(k|m|million|thousand)?\b/i.exec(s);
  if (!m) return undefined;
  let v = Number(`${(m[1] ?? "").replace(/,/g, "")}${m[2] ?? ""}`);
  const unit = (m[3] ?? "").toLowerCase();
  if (unit === "k" || unit === "thousand") v *= 1000;
  else if (unit === "m" || unit === "million") v *= 1_000_000;
  if (!Number.isFinite(v) || v <= 0 || v > 1e11) return undefined;
  return Math.round(v * 100);
}
export const formatCents = (c: number): string => `$${Math.round(c / 100).toLocaleString("en-AU")}`;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Dates such as 12/03/2026, 12 March 2026, 12th Mar 26 (Australian day-first order). ISO yyyy-mm-dd out, or undefined. */
export function findDates(text: string): { iso: string; index: number; raw: string }[] {
  const out: { iso: string; index: number; raw: string }[] = [];
  const push = (d: number, mo: number, y: number, index: number, raw: string) => {
    const yy = y < 100 ? 2000 + y : y;
    const dt = new Date(Date.UTC(yy, mo - 1, d));
    if (yy < 1990 || yy > 2100 || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return;
    out.push({ iso: dt.toISOString().slice(0, 10), index, raw });
  };
  for (const m of text.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) push(Number(m[1]), Number(m[2]), Number(m[3]), m.index ?? 0, m[0]);
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(\d{4}|\d{2})\b/gi)) {
    push(Number(m[1]), MONTHS.indexOf((m[2] ?? "").toLowerCase()) + 1, Number(m[3]), m.index ?? 0, m[0]);
  }
  return out.sort((a, b) => a.index - b.index);
}

const around = (text: string, index: number, len: number, pad = 90): string => quote(text.slice(Math.max(0, index - pad), Math.min(text.length, index + len + pad)));

/** A sentence is negated when it says the problem is absent ("no evidence of termite activity"). */
const NEGATED = /\b(no|not|nil|none|without|free\s+of|nothing|did\s+not|didn['’]t|was\s+not|were\s+not|absent|clear\s+of)\b[^.;]{0,40}\b(evidence|sign|signs|visible|detected|found|observed|noted|activity|present|damage|defect|issue|problem)s?\b/i;

// ---- Classification -------------------------------------------------------------------------------------------------------------

const CLASS_HINTS: Record<Exclude<DocClass, "unknown">, RegExp[]> = {
  inspection: [/\binspection\b/i, /\bdefects?\b/i, /\bbuilding\s+(and|&)\s+pest\b/i, /\btermite|timber\s+pest\b/i, /\bstructural\b/i, /\bmoisture\b/i, /\bas\s+1851|as\s+4349\b/i, /\broof\s+(void|space)\b/i, /\bsubfloor\b/i],
  contract: [/\bcontract\s+of\s+sale\b/i, /\bvendor\b/i, /\bpurchaser\b/i, /\bsettlement\b/i, /\bdeposit\b/i, /\bcooling[- ]off\b/i, /\bspecial\s+conditions?\b/i, /\bconveyanc/i, /\bwhereas|hereinafter|the\s+parties\b/i, /\bclause\s+\d/i],
  market: [/\bmedian\b/i, /\bclearance\s+rate\b/i, /\bdays\s+on\s+market\b/i, /\brental\s+yield\b/i, /\bvacancy\s+rate\b/i, /\bmarket\s+(report|update|trends?)\b/i, /\bquarterly\b/i, /\bsuburb\s+(profile|report)\b/i, /\bannual\s+growth|capital\s+growth\b/i],
  email: [/^(from|to|subject|date|cc):/im, /\b(kind\s+regards|best\s+regards|regards|cheers|thanks|thank\s+you),?\s*$/im, /^\s*(hi|hello|dear)\b/im, /\bplease\s+(find|see|confirm|let\s+me\s+know)\b/i]
};

export function classifyDocument(text: string, hint?: string): DocClass {
  if (hint === "building_inspection" || hint === "pest_report") return "inspection";
  if (hint === "contract" || hint === "title_search") return "contract";
  const score = (res: RegExp[]) => res.reduce((n, r) => n + (r.test(text) ? 1 : 0), 0);
  const ranked = (Object.keys(CLASS_HINTS) as (keyof typeof CLASS_HINTS)[]).map(k => [k, score(CLASS_HINTS[k])] as const).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  return top && top[1] >= 2 ? top[0] : "unknown";
}

// ---- Summary pieces -------------------------------------------------------------------------------------------------------------

/** Extractive key points: the sentences carrying the most document-specific words, numbers and risk terms, kept in reading order. */
export function keySentences(text: string, max = 5): string[] {
  const sentences = splitSentences(text).slice(0, 4000);
  if (sentences.length === 0) return [];
  const freq = new Map<string, number>();
  for (const s of sentences) for (const w of new Set(wordsOf(s))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const important = /\b(must|shall|required|defect|risk|urgent|immediately|recommend|warning|deadline|penalty|unless|failure|not\s+compliant|significant|major|total|price|deposit|settlement|median|growth)\b/i;
  const scored = sentences.map((s, i) => {
    const ws = wordsOf(s);
    if (ws.length < 4 || s.length > 400) return { s, i, v: -1 };
    const tf = ws.reduce((n, w) => n + Math.min(freq.get(w) ?? 0, 6), 0) / Math.sqrt(ws.length);
    const v = tf + (/\d/.test(s) ? 1.5 : 0) + (/\$/.test(s) ? 1.5 : 0) + (important.test(s) ? 3 : 0) + (i < 3 ? 1 : 0) - (NEGATED.test(s) ? 0.5 : 0);
    return { s, i, v };
  });
  return scored.filter(x => x.v > 0).sort((a, b) => b.v - a.v).slice(0, max).sort((a, b) => a.i - b.i).map(x => quote(x.s, 260));
}

const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const bySeverity = <T extends { severity: Severity }>(a: T, b: T) => SEV_RANK[a.severity] - SEV_RANK[b.severity];

export function rate(risks: readonly Finding[]): Rating {
  if (risks.some(r => r.severity === "high")) return "red";
  if (risks.some(r => r.severity === "medium")) return "amber";
  return "green";
}

interface Rule { id: string; severity: Severity; title: string; why: string; action: string; re: RegExp; /** Skips matches that mean the opposite. */ skip?: RegExp }

/** Runs a rule table over the sentences. One finding per rule (the first match), quoting the sentence it came from. */
function runRules(rules: readonly Rule[], sentences: readonly string[]): Finding[] {
  const out: Finding[] = [];
  for (const r of rules) {
    const hit = sentences.find(s => r.re.test(s) && !NEGATED.test(s) && !(r.skip?.test(s)));
    if (hit) out.push({ id: r.id, severity: r.severity, title: r.title, why: r.why, action: r.action, excerpt: quote(hit) });
  }
  return out;
}

// ---- Contract -------------------------------------------------------------------------------------------------------------------

const CONTRACT_RULES: readonly Rule[] = [
  { id: "contract.cooling_off_waived", severity: "high", title: "Cooling-off rights waived or excluded", why: "You may lose the right to back out for a short period after signing.", action: "Ask your solicitor what you give up before you sign.", re: /(waiv\w+|exclud\w+|not\s+apply|does\s+not\s+apply|no)\b[^.\n]{0,40}cooling[- ]off|cooling[- ]off[^.\n]{0,50}(waiv\w+|exclud\w+|not\s+apply|does\s+not\s+apply|not\s+available)/i },
  { id: "contract.no_finance_condition", severity: "high", title: "No finance condition (unconditional)", why: "If your loan falls through you could still be bound to settle and lose your deposit.", action: "Get written loan approval first, or ask for a subject-to-finance condition.", re: /unconditional|not\s+(be\s+)?subject\s+to\s+(finance|a\s+loan)|no\s+(finance|loan)\s+(condition|clause)|without\s+(a\s+)?finance\s+(condition|clause)/i },
  { id: "contract.as_is", severity: "medium", title: "Sold 'as is' with no warranties", why: "The seller gives no promise about condition, so repairs are on the buyer.", action: "Get a building and pest inspection before you commit.", re: /\bas[- ]is\b|\bno\s+warrant(y|ies)\b|\bbuyer\s+accepts\s+the\s+property\s+in\s+its\s+present\s+(state|condition)/i },
  { id: "contract.time_of_essence", severity: "medium", title: "Time is of the essence", why: "A missed date, even by a day, can let the other side end the contract.", action: "Diarise every date and tell your solicitor and lender.", re: /time\s+is\s+(of\s+the\s+)?essence/i },
  { id: "contract.deposit_forfeit", severity: "medium", title: "Deposit may be forfeited or non-refundable", why: "Money you pay up front can be lost if you default or the contract ends.", action: "Confirm the exact conditions in which the deposit is returned.", re: /(deposit|money)[^.\n]{0,60}(non[- ]?refundable|forfeit\w*|retained\s+by\s+the\s+vendor|lost)|non[- ]?refundable[^.\n]{0,30}deposit/i },
  { id: "contract.vendor_rescind", severity: "medium", title: "Seller may end the contract", why: "The seller has a right to cancel or rescind under stated conditions.", action: "Ask your solicitor when this right can be used and what you get back.", re: /vendor\s+(may|can|is\s+entitled\s+to)\s+(rescind|terminate|cancel|withdraw)|right\s+to\s+(rescind|terminate)/i },
  { id: "contract.sunset", severity: "medium", title: "Sunset or completion deadline", why: "A long-stop date can let the seller or developer cancel if the sale is not finished in time.", action: "Check the date and whether either side can cancel when it passes.", re: /sunset\s+(date|clause)|completion\s+date\s+(not\s+later|no\s+later)/i },
  { id: "contract.special_levy", severity: "medium", title: "Strata levies, arrears or special levy", why: "Unpaid or planned levies can become the buyer's cost.", action: "Ask for the strata certificate and minutes, and check what is owing at settlement.", re: /special\s+levy|levy\s+arrears|strata\s+arrears|owners\s+corporation\s+(debt|arrears)|sinking\s+fund\s+(deficit|shortfall)/i },
  { id: "contract.easement_covenant", severity: "low", title: "Easement, covenant or encumbrance on title", why: "Rights of others over the land can limit what you can build or do.", action: "Read the title search and ask your solicitor how it affects your plans.", re: /\beasements?\b|\bcovenants?\b|\bencumbrances?\b|\bcaveats?\b|\bmortgage\s+to\s+be\s+discharged\b/i },
  { id: "contract.buyer_costs", severity: "low", title: "Buyer pays extra costs", why: "Costs such as survey, transfer or adjustments are placed on the buyer.", action: "Add these to your budget before you sign.", re: /(buyer|purchaser)\s+(shall|must|will|agrees\s+to)\s+(pay|bear)\s+(all|the\s+cost)/i },
  { id: "contract.assignment_limits", severity: "low", title: "Limits on selling or assigning the contract", why: "You may not be able to transfer your rights before settlement.", action: "Ask your solicitor if this affects you.", re: /(not|no)\s+(assign|transfer|nominate)\w*\s+(the\s+)?(contract|rights)|may\s+not\s+assign/i },
  { id: "contract.unusual_special", severity: "low", title: "Special conditions present", why: "Special conditions change the standard terms and are where unusual terms hide.", action: "Have your solicitor read every special condition.", re: /special\s+conditions?\b/i },
  { id: "contract.gst", severity: "low", title: "GST or margin scheme mentioned", why: "The price may or may not include GST, which changes what you pay.", action: "Confirm in writing whether the price includes GST.", re: /\bgst\b|margin\s+scheme/i, skip: /includes?\s+gst|gst[- ]inclusive/i }
];

export function extractContractFacts(text: string): { facts: Fact[]; priceCents?: number; depositCents?: number; settlementDays?: number; coolingOffDays?: number } {
  const facts: Fact[] = [];
  const add = (f: Fact) => { facts.push(f); };
  let priceCents: number | undefined, depositCents: number | undefined, settlementDays: number | undefined, coolingOffDays: number | undefined;
  const price = /(?:purchase\s+price|contract\s+price|sale\s+price|the\s+price|price)\b[^$\n]{0,40}(\$\s?[\d,]+(?:\.\d{1,2})?\s?(?:k|m|million)?)/i.exec(text);
  if (price?.[1]) { priceCents = moneyToCents(price[1]); if (priceCents) add({ label: "Price", value: formatCents(priceCents), kind: "money", cents: priceCents, excerpt: around(text, price.index, price[0].length, 40) }); }
  const dep = /deposit\b[^$%\n]{0,50}?(\$\s?[\d,]+(?:\.\d{1,2})?|(\d{1,2}(?:\.\d+)?)\s?%)/i.exec(text);
  if (dep) {
    if (dep[2]) { const pct = Number(dep[2]); add({ label: "Deposit", value: `${pct}%`, kind: "percent", num: pct, excerpt: around(text, dep.index, dep[0].length, 40) }); if (priceCents) depositCents = Math.round(priceCents * pct / 100); }
    else if (dep[1]) { depositCents = moneyToCents(dep[1]); if (depositCents) add({ label: "Deposit", value: formatCents(depositCents), kind: "money", cents: depositCents, excerpt: around(text, dep.index, dep[0].length, 40) }); }
  }
  const settle = /settle(?:ment)?\b[^.\n]{0,70}?(\d{1,3})\s*(business\s+|working\s+|calendar\s+)?days/i.exec(text) ?? /(\d{1,3})\s*(business\s+|working\s+|calendar\s+)?days\s+(?:after|from|of)\s+(?:the\s+)?(?:date\s+of\s+)?(?:contract|exchange)/i.exec(text);
  if (settle) { settlementDays = Number(settle[1]); add({ label: "Settlement period", value: `${settlementDays} ${settle[2]?.trim() ? `${settle[2].trim()} ` : ""}days`, kind: "days", num: settlementDays, excerpt: around(text, settle.index, settle[0].length, 40) }); }
  const cool = /cooling[- ]off[^.\n]{0,80}?(\d{1,2})\s*(business\s+)?days/i.exec(text);
  if (cool) { coolingOffDays = Number(cool[1]); add({ label: "Cooling-off period", value: `${coolingOffDays} ${cool[2] ? "business " : ""}days`, kind: "days", num: coolingOffDays, excerpt: around(text, cool.index, cool[0].length, 40) }); }
  const interest = /(?:interest|penalt\w+)[^.\n%]{0,60}?(\d{1,2}(?:\.\d+)?)\s?%\s*(?:p\.?a\.?|per\s+annum)?/i.exec(text);
  if (interest) add({ label: "Interest or penalty rate", value: `${interest[1]}%`, kind: "percent", num: Number(interest[1]), excerpt: around(text, interest.index, interest[0].length, 40) });
  const settleDate = /settle(?:ment)?\b[^.\n]{0,60}?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{2,4})/i.exec(text);
  if (settleDate?.[1]) { const d = findDates(settleDate[1])[0]; if (d) add({ label: "Settlement date", value: d.iso, kind: "date", excerpt: around(text, settleDate.index, settleDate[0].length, 40) }); }
  return {
    facts,
    ...(priceCents !== undefined ? { priceCents } : {}), ...(depositCents !== undefined ? { depositCents } : {}),
    ...(settlementDays !== undefined ? { settlementDays } : {}), ...(coolingOffDays !== undefined ? { coolingOffDays } : {})
  };
}

function analyseContract(text: string, sentences: string[]): Pick<Analysis, "facts" | "risks" | "opportunities"> {
  const x = extractContractFacts(text);
  const risks = runRules(CONTRACT_RULES, sentences);
  const num = (label: string) => x.facts.find(f => f.label === label);
  if (x.priceCents && x.depositCents && x.depositCents / x.priceCents > 0.1001) {
    risks.push({ id: "contract.high_deposit", severity: "medium", title: "Deposit is more than 10% of the price", why: "A larger deposit is more money at risk if the deal fails; 10% is the usual ceiling.", action: "Ask whether the deposit can be lowered or held in a trust account.", excerpt: num("Deposit")?.excerpt ?? "" });
  }
  if (x.settlementDays !== undefined && x.settlementDays < 28) {
    risks.push({ id: "contract.short_settlement", severity: "medium", title: `Short settlement (${x.settlementDays} days)`, why: "Less time to arrange finance, searches and moving.", action: "Check your lender and solicitor can finish in time, or ask for longer.", excerpt: num("Settlement period")?.excerpt ?? "" });
  } else if (x.settlementDays !== undefined && x.settlementDays > 90) {
    risks.push({ id: "contract.long_settlement", severity: "low", title: `Long settlement (${x.settlementDays} days)`, why: "Prices, rates and your own plans can change while the deal is open.", action: "Check rates and loan approval will still hold at settlement.", excerpt: num("Settlement period")?.excerpt ?? "" });
  }
  const interest = num("Interest or penalty rate");
  if (interest?.num !== undefined && interest.num >= 10) {
    risks.push({ id: "contract.high_penalty_interest", severity: "high", title: `High default interest (${interest.value})`, why: "Late payment can cost much more than usual interest.", action: "Ask your solicitor to negotiate the rate down or add a grace period.", excerpt: interest.excerpt ?? "" });
  }
  const opportunities: Opportunity[] = [];
  const finance = sentencesHit(sentences, /subject\s+to\s+(finance|a\s+building|a\s+pest|inspection|sale\s+of)/i);
  if (finance && !risks.some(r => r.id === "contract.no_finance_condition")) opportunities.push({ id: "contract.protective_condition", title: "A protective condition is included", why: "A subject-to condition gives you a way out if it is not met.", excerpt: quote(finance) });
  if (x.coolingOffDays !== undefined && x.coolingOffDays >= 3 && !risks.some(r => r.id === "contract.cooling_off_waived")) opportunities.push({ id: "contract.cooling_off", title: `Cooling-off period of ${x.coolingOffDays} days`, why: "You have time to reconsider or get advice after signing.", excerpt: num("Cooling-off period")?.excerpt ?? "" });
  return { facts: x.facts, risks, opportunities };
}

const sentencesHit = (sentences: readonly string[], re: RegExp): string | undefined => sentences.find(s => re.test(s) && !NEGATED.test(s));

// ---- Inspection -----------------------------------------------------------------------------------------------------------------

interface CostRule extends Rule { category: string; lowCents: number; highCents: number }
const c = (dollars: number) => dollars * 100;
const INSPECTION_RULES: readonly CostRule[] = [
  { id: "insp.structural", category: "Structural", severity: "high", title: "Structural movement or damage", why: "Cracking, subsidence or failing members can be costly and affect safety and lending.", action: "Get a structural engineer's report before you commit.", re: /subsidence|underpinning|structural\s+(defect|damage|movement|failure|crack\w*)|significant\s+crack\w*|crack\w*\s+(in|to|through)\s+(the\s+)?(wall|slab|footing|foundation|brick)|sagging|rotted?\s+(bearer|joist|stump|frame)|(bearer|joist|stump)s?\b[^.]{0,30}\b(rot|failed|decayed)|differential\s+movement/i, lowCents: c(15_000), highCents: c(80_000) },
  { id: "insp.termites", category: "Termites", severity: "high", title: "Termite activity or damage", why: "Termites can hollow out timber quickly; repair and treatment are on the owner.", action: "Get a licensed pest controller's treatment quote and a damage assessment.", re: /(active|live)\s+(termite|subterranean)|termite\s+(damage|activity|workings|infestation)|termites?\s+(were\s+)?(found|detected|observed)|evidence\s+of\s+(active\s+)?termites/i, lowCents: c(3_000), highCents: c(20_000) },
  { id: "insp.asbestos", category: "Asbestos", severity: "high", title: "Asbestos present or suspected", why: "Disturbing asbestos is a health risk and removal must be done by licensed people.", action: "Get an asbestos register or test, and a licensed removal quote before any renovation.", re: /asbestos|fibro(?!us)\b|\bac\s+sheet(ing)?\b/i, lowCents: c(2_000), highCents: c(25_000) },
  { id: "insp.unapproved", category: "Unapproved works", severity: "high", title: "Unapproved or non-compliant building work", why: "Council can order work to be fixed or removed, and insurers may refuse claims.", action: "Ask for approvals and certificates, and check with council.", re: /unapproved|un-?permitted|without\s+(a\s+)?(permit|approval|consent)|illegal\s+(work|structure|building)|no\s+(building\s+)?(permit|approval|certificate)\b|not\s+(council\s+)?approved/i, lowCents: c(5_000), highCents: c(50_000) },
  { id: "insp.safety", category: "Safety", severity: "high", title: "Safety hazard or non-compliance", why: "Items such as smoke alarms, pool fences and balustrades are legal requirements.", action: "Have these fixed or certified before settlement or occupancy.", re: /no\s+smoke\s+alarm|smoke\s+alarms?\s+(missing|not\s+(compliant|working|installed))|pool\s+(fence|barrier|gate)\s+(non|not|is\s+not|fails|defect)|non[- ]?compliant\s+(pool|balustrade|barrier)|balustrade\s+(is\s+)?(loose|low|non|not)|unsafe|safety\s+(hazard|risk)|trip\s+hazard|fall\s+hazard/i, lowCents: c(300), highCents: c(5_000) },
  { id: "insp.electrical", category: "Electrical", severity: "high", title: "Electrical fault or non-compliance", why: "Faulty wiring is a fire and shock risk.", action: "Get a licensed electrician to inspect and quote.", re: /exposed\s+wir\w+|non[- ]?compliant\s+(wiring|electrical)|(no|missing)\s+(rcd|safety\s+switch)|electrical\s+(fault|hazard|defect)|ceramic\s+fuses?|aluminium\s+wiring|overloaded\s+circuit/i, lowCents: c(1_000), highCents: c(15_000) },
  { id: "insp.water", category: "Water and damp", severity: "medium", title: "Water damage, damp or mould", why: "Moisture problems tend to spread and can hide rot, so the fix may be bigger than it looks.", action: "Find the source of the moisture and get a quote to fix both the cause and the damage.", re: /water\s+(damage|ingress|leak\w*|stain\w*)|rising\s+damp|\bmould|\bmold|moisture\s+(reading|meter)\w*\s+(high|elevated)|elevated\s+moisture|leak\w*\s+(roof|pipe|shower|tap)|failed\s+waterproofing|shower\s+(leak|waterproof\w*\s+(fail|defect))/i, lowCents: c(2_000), highCents: c(25_000) },
  { id: "insp.roof", category: "Roof and gutters", severity: "medium", title: "Roof, gutter or flashing defects", why: "A damaged roof lets water in and gets worse over time.", action: "Get a roofer to inspect and quote repairs.", re: /(broken|cracked|slipped|missing)\s+(roof\s+)?tiles?|rust\w*\s+(roof|gutter|flashing|sheet)|(roof|gutter|flashing)s?\b[^.]{0,30}\b(damaged|rusted|corroded|leak\w*|failed|deteriorat\w*)|roof\s+(has\s+)?reached\s+(the\s+)?end/i, lowCents: c(500), highCents: c(15_000) },
  { id: "insp.plumbing", category: "Plumbing", severity: "medium", title: "Plumbing defects", why: "Old or damaged pipes can leak or fail without warning.", action: "Get a licensed plumber to inspect and quote.", re: /galvanised\s+(pipe|water)|lead\s+(pipe|solder)|polybutylene|(blocked|leaking|corroded|damaged)\s+(drain|pipe|stormwater|sewer)|low\s+water\s+pressure|hot\s+water\s+(system\s+)?(is\s+)?(old|failed|leak\w*|end\s+of\s+life)/i, lowCents: c(500), highCents: c(10_000) },
  { id: "insp.minor", category: "Minor and cosmetic", severity: "low", title: "Minor or cosmetic defects", why: "Common wear and tear; usually cheap but they add up.", action: "Budget for routine repairs and painting.", re: /minor\s+(defect|crack\w*|damage|wear|repair)|cosmetic|wear\s+and\s+tear|hairline\s+crack|peeling\s+paint|needs?\s+(repainting|painting)|sticking\s+(door|window)/i, lowCents: c(200), highCents: c(3_000) }
];

const POSITIVE_INSPECTION: readonly { id: string; re: RegExp; title: string; why: string }[] = [
  { id: "insp.good_condition", re: /well[- ]maintained|good\s+(overall\s+)?condition|above\s+average\s+condition|satisfactory\s+condition/i, title: "Reported in good condition", why: "The inspector describes the property as well kept." },
  { id: "insp.no_major", re: /no\s+major\s+(defects?|structural|issues?)|no\s+significant\s+(defects?|structural|issues?)/i, title: "No major defects reported", why: "Fewer big-ticket repairs expected." },
  { id: "insp.no_pests", re: /no\s+(evidence\s+of\s+)?(active\s+)?(termites?|timber\s+pest\w*|pest\s+activity)|free\s+of\s+(termites?|timber\s+pest\w*)/i, title: "No timber pest activity reported", why: "No termites or other timber pests were found on the day." }
];

/** A dollar amount stated inside a finding sentence, taken as the quoted cost to fix. */
const statedCost = (s: string): number | undefined => /(?:cost|estimate\w*|quote\w*|repair\w*|approx\w*|allow\w*|budget\w*|up\s+to|around|about)[^$]{0,40}(\$\s?[\d,]+(?:\.\d{1,2})?\s?(?:k)?)/i.exec(s)?.[1] ? moneyToCents(/(\$\s?[\d,]+(?:\.\d{1,2})?\s?(?:k)?)/i.exec(s)?.[1] ?? "") : undefined;

function analyseInspection(text: string, sentences: string[]): Pick<Analysis, "facts" | "risks" | "opportunities" | "cost"> {
  const risks: Finding[] = [];
  let low = 0, high = 0, stated = 0, indicative = 0;
  for (const r of INSPECTION_RULES) {
    const idx = sentences.flatMap((s, i) => r.re.test(s) && !NEGATED.test(s) ? [i] : []);
    const first = idx[0] !== undefined ? sentences[idx[0]] : undefined;
    if (!first) continue;
    // A cost is often in the sentence after the finding ("Cost to treat is about $4,500."), so look at both.
    const quotes = idx.map(i => statedCost(`${sentences[i] ?? ""} ${INSPECTION_RULES.some(o => o.re.test(sentences[i + 1] ?? "")) ? "" : sentences[i + 1] ?? ""}`)).filter((v): v is number => v !== undefined);
    const statedTotal = quotes.length ? quotes.reduce((a, b) => a + b, 0) : undefined;
    const costLowCents = statedTotal ?? r.lowCents, costHighCents = statedTotal ?? r.highCents;
    low += costLowCents; high += costHighCents;
    if (statedTotal !== undefined) stated++; else indicative++;
    risks.push({ id: r.id, severity: r.severity, title: r.title, why: r.why, action: r.action, excerpt: quote(first), costLowCents, costHighCents });
  }
  const opportunities: Opportunity[] = [];
  for (const p of POSITIVE_INSPECTION) {
    const hit = sentences.find(s => p.re.test(s));
    if (hit) opportunities.push({ id: p.id, title: p.title, why: p.why, excerpt: quote(hit) });
  }
  const facts: Fact[] = [];
  const date = findDates(text)[0];
  if (date) facts.push({ label: "Report date", value: date.iso, kind: "date", excerpt: around(text, date.index, date.raw.length, 30) });
  const count = risks.length;
  facts.push({ label: "Defect categories flagged", value: String(count), kind: "number", num: count });
  const cost: CostEstimate | undefined = count > 0 ? { lowCents: low, highCents: high, basis: stated && indicative ? "mixed" : stated ? "stated" : "indicative" } : undefined;
  return { facts, risks, opportunities, ...(cost ? { cost } : {}) };
}

// ---- Market research ------------------------------------------------------------------------------------------------------------

const MARKET_STATS: readonly { label: string; kind: FactKind; re: RegExp }[] = [
  { label: "Median price", kind: "money", re: /median\s+(?:house\s+|unit\s+|dwelling\s+|sale\s+)?price[^$\n]{0,40}(\$\s?[\d,.]+\s?(?:k|m|million)?)/i },
  { label: "Annual growth", kind: "percent", re: /(?:annual|yearly|12[- ]month|capital)\s+(?:price\s+|capital\s+)?growth[^%\n]{0,40}?(-?\d+(?:\.\d+)?)\s?%/i },
  { label: "Quarterly change", kind: "percent", re: /(?:quarterly|3[- ]month)\s+(?:price\s+)?(?:change|growth)[^%\n]{0,40}?(-?\d+(?:\.\d+)?)\s?%/i },
  { label: "Days on market", kind: "days", re: /(?:median\s+)?days\s+on\s+market[^\d\n]{0,25}(\d{1,3})/i },
  { label: "Clearance rate", kind: "percent", re: /clearance\s+rate[^%\n]{0,40}?(\d{1,3}(?:\.\d+)?)\s?%/i },
  { label: "Rental yield", kind: "percent", re: /(?:gross\s+|net\s+)?rental\s+yield[^%\n]{0,40}?(\d{1,2}(?:\.\d+)?)\s?%/i },
  { label: "Vacancy rate", kind: "percent", re: /vacancy\s+rate[^%\n]{0,40}?(\d{1,2}(?:\.\d+)?)\s?%/i },
  { label: "Median rent", kind: "money", re: /median\s+(?:weekly\s+)?rent[^$\n]{0,40}(\$\s?[\d,.]+)/i }
];

function analyseMarket(text: string, sentences: string[]): Pick<Analysis, "facts" | "risks" | "opportunities"> {
  const facts: Fact[] = [];
  for (const s of MARKET_STATS) {
    const m = s.re.exec(text);
    if (!m?.[1]) continue;
    const excerpt = around(text, m.index, m[0].length, 30);
    if (s.kind === "money") { const cents = moneyToCents(m[1]); if (cents) facts.push({ label: s.label, value: formatCents(cents), kind: "money", cents, excerpt }); }
    else { const n = Number(m[1]); if (Number.isFinite(n)) facts.push({ label: s.label, value: s.kind === "percent" ? `${n}%` : `${n} days`, kind: s.kind, num: n, excerpt }); }
  }
  const f = (label: string) => facts.find(x => x.label === label);
  const risks: Finding[] = [], opportunities: Opportunity[] = [];
  const risk = (id: string, severity: Severity, title: string, why: string, action: string, excerpt: string) => risks.push({ id, severity, title, why, action, excerpt });
  const opp = (id: string, title: string, why: string, excerpt: string) => opportunities.push({ id, title, why, excerpt });
  const growth = f("Annual growth"), q = f("Quarterly change"), dom = f("Days on market"), clr = f("Clearance rate"), yld = f("Rental yield"), vac = f("Vacancy rate");
  if (growth?.num !== undefined && growth.num < 0) risk("market.falling_prices", "high", `Prices fell ${Math.abs(growth.num)}% over the year`, "Falling prices can erode equity and weaken your selling position.", "Price with recent sales, not last year's peak.", growth.excerpt ?? "");
  else if (growth?.num !== undefined && growth.num >= 5) opp("market.strong_growth", `Strong growth (${growth.value} a year)`, "Rising prices favour sellers and owners.", growth.excerpt ?? "");
  if (q?.num !== undefined && q.num < -1) risk("market.recent_slide", "medium", `Prices slipped ${Math.abs(q.num)}% last quarter`, "A recent fall can be the start of a trend.", "Watch next quarter's figures before setting your price.", q.excerpt ?? "");
  if (dom?.num !== undefined && dom.num > 60) risk("market.slow_sales", "medium", `Slow sales (${dom.num} days on market)`, "Homes take longer to sell, so expect more negotiation.", "Price competitively from day one.", dom.excerpt ?? "");
  else if (dom?.num !== undefined && dom.num <= 30) opp("market.fast_sales", `Quick sales (${dom.num} days on market)`, "Demand is strong; well-priced homes sell fast.", dom.excerpt ?? "");
  if (clr?.num !== undefined && clr.num < 55) risk("market.weak_clearance", "medium", `Weak auction clearance (${clr.value})`, "Many homes are passing in, which signals soft demand.", "Consider a private sale or a realistic reserve.", clr.excerpt ?? "");
  else if (clr?.num !== undefined && clr.num >= 70) opp("market.strong_clearance", `Strong clearance rate (${clr.value})`, "Buyers are active and competing.", clr.excerpt ?? "");
  if (vac?.num !== undefined && vac.num > 3) risk("market.high_vacancy", "medium", `High vacancy rate (${vac.value})`, "Rentals take longer to fill, which hurts investors.", "Allow for empty weeks in your cash flow.", vac.excerpt ?? "");
  else if (vac?.num !== undefined && vac.num <= 1.5) opp("market.tight_rentals", `Tight rental market (${vac.value} vacancy)`, "Landlords have pricing power.", vac.excerpt ?? "");
  if (yld?.num !== undefined && yld.num >= 5) opp("market.high_yield", `Solid rental yield (${yld.value})`, "Rent covers more of the cost of holding the property.", yld.excerpt ?? "");
  else if (yld?.num !== undefined && yld.num < 3) risk("market.low_yield", "low", `Low rental yield (${yld.value})`, "Returns rely on price growth rather than rent.", "Run the numbers with your loan costs.", yld.excerpt ?? "");
  const rising = sentencesHit(sentences, /(interest\s+rates?|cash\s+rate)[^.]{0,40}(rise|rising|increase|hike)/i);
  if (rising) risk("market.rates_rising", "medium", "Rising interest rates mentioned", "Higher repayments reduce what buyers can pay.", "Stress-test your loan at a higher rate.", quote(rising));
  const supply = sentencesHit(sentences, /(stock|listings|supply)[^.]{0,30}(rise|rising|increase|up\s+\d|surge)/i);
  if (supply) risk("market.rising_supply", "low", "More stock coming to market", "More choice for buyers can cap price growth.", "Check competing listings nearby.", quote(supply));
  const tight = sentencesHit(sentences, /(low|tight|limited|undersupply)[^.]{0,30}(stock|supply|listings)|strong\s+demand/i);
  if (tight) opp("market.tight_supply", "Limited supply or strong demand", "Fewer homes for sale supports prices.", quote(tight));
  return { facts, risks, opportunities };
}

// ---- Email ----------------------------------------------------------------------------------------------------------------------

const EMAIL_RULES: readonly Rule[] = [
  { id: "email.payment_change", severity: "high", title: "Change of bank or payment details", why: "A late change of account details is the classic settlement-fraud trick.", action: "Do not pay. Phone the sender on a number you already trust and confirm in person.", re: /(change|update|new)\s+(of\s+)?(bank|account|payment|banking|bsb)\s*(details|number|account)?|new\s+bsb|bank\s+details\s+(have\s+)?changed|transfer\s+(the\s+)?(deposit|funds|payment)\s+to\s+(this|the\s+following|our\s+new)/i },
  { id: "email.unusual_payment", severity: "high", title: "Unusual payment method requested", why: "Gift cards, crypto and wire transfers to strangers are rarely recoverable.", action: "Refuse and verify who is asking by phone.", re: /gift\s+cards?|bitcoin|crypto(currency)?|western\s+union|wire\s+transfer|itunes\s+card|prepaid\s+card/i },
  { id: "email.credentials", severity: "high", title: "Asks for ID, passwords or codes", why: "Legitimate parties do not ask for passwords or one-time codes by email.", action: "Do not reply. Report it as phishing.", re: /(send|provide|confirm|verify)\s+(me\s+)?(your\s+)?(password|passcode|pin|one[- ]time\s+code|verification\s+code|passport|licen[cs]e\s+(number|photo)|tax\s+file\s+number|tfn|medicare)/i },
  { id: "email.pressure", severity: "medium", title: "Pressure to act quickly", why: "Urgency is used to stop you checking.", action: "Take time to verify the request before you act.", re: /\b(urgent(ly)?|immediately|right\s+away|act\s+now|today\s+only|within\s+(the\s+next\s+)?\d+\s+hours?|last\s+chance|final\s+notice|asap)\b/i },
  { id: "email.suspicious_link", severity: "medium", title: "Link to click or file to open", why: "Links and attachments in unexpected emails can steal logins.", action: "Open the site yourself, not through the link.", re: /click\s+(the\s+)?(link|here|below)|https?:\/\/\S+|open\s+the\s+attached|download\s+the\s+attached/i },
  { id: "email.legal_threat", severity: "medium", title: "Legal or default threat", why: "A threat may be a pressure tactic or a real notice that has a deadline.", action: "Send it to your solicitor today.", re: /\b(breach|default|terminate|legal\s+action|solicitor|lawyer|court|notice\s+to\s+(complete|remedy))\b/i },
  { id: "email.price_change", severity: "low", title: "Price or offer discussed", why: "Money terms in email can be misread; make sure they are confirmed in the platform.", action: "Check the amount against the offer in your account.", re: /\b(offer|counter[- ]?offer|price\s+(reduction|drop|change)|reduce\s+the\s+price)\b[^.]{0,60}\$/i }
];

function analyseEmail(text: string, sentences: string[]): Pick<Analysis, "facts" | "risks" | "opportunities" | "actionItems"> {
  const facts: Fact[] = [];
  const subject = /^subject:\s*(.+)$/im.exec(text)?.[1];
  const from = /^from:\s*(.+)$/im.exec(text)?.[1];
  if (subject) facts.push({ label: "Subject", value: quote(subject, 120), kind: "text" });
  if (from) facts.push({ label: "From", value: quote(from.replace(/<[^>]*>/g, "").trim() || from, 80), kind: "text" });
  for (const m of text.matchAll(/\$\s?[\d,]+(?:\.\d{1,2})?\s?(?:k|m)?/gi)) {
    const cents = moneyToCents(m[0]);
    if (cents && facts.filter(f => f.kind === "money").length < 5) facts.push({ label: "Amount mentioned", value: formatCents(cents), kind: "money", cents, excerpt: around(text, m.index ?? 0, m[0].length, 40) });
  }
  const risks = runRules(EMAIL_RULES, sentences);
  const actionItems: ActionItem[] = [];
  const ASK = /\b(please|can\s+you|could\s+you|would\s+you|need\s+you\s+to|kindly|make\s+sure|don['’]t\s+forget|remember\s+to|must|required\s+to|let\s+(me|us)\s+know|confirm|send|sign|pay|attend|return|provide)\b/i;
  for (const s of sentences) {
    if (!ASK.test(s) || s.length > 300 || /^(thanks|thank\s+you|regards)/i.test(s)) continue;
    const due = findDates(s)[0]?.iso;
    const urgent = /\b(urgent|today|tomorrow|asap|immediately)\b/i.test(s);
    actionItems.push({ text: quote(s, 200), priority: urgent ? "high" : due ? "medium" : "low", ...(due ? { due } : {}) });
    if (actionItems.length >= 8) break;
  }
  for (const q of sentences.filter(s => s.endsWith("?")).slice(0, 3)) if (!actionItems.some(a => a.text === quote(q, 200))) actionItems.push({ text: `Answer: ${quote(q, 190)}`, priority: "low" });
  return { facts, risks, opportunities: [], actionItems };
}

// ---- Putting it together --------------------------------------------------------------------------------------------------------

const LABEL: Record<DocClass, string> = { inspection: "Inspection report", contract: "Contract", market: "Market research", email: "Email", unknown: "Document" };
export const docClassLabel = (c: DocClass): string => LABEL[c];

export function analyseDocument(rawText: string, opts: { hintKind?: string; forceClass?: DocClass } = {}): Analysis {
  const text = cleanText(rawText);
  const wordCount = (text.match(/\S+/g) ?? []).length;
  const docClass = opts.forceClass ?? classifyDocument(text, opts.hintKind);
  const sentences = splitSentences(text);
  const notes: string[] = [];
  let part: Pick<Analysis, "facts" | "risks" | "opportunities"> & { actionItems?: ActionItem[]; cost?: CostEstimate };
  switch (docClass) {
    case "contract": part = analyseContract(text, sentences); break;
    case "inspection": part = analyseInspection(text, sentences); break;
    case "market": part = analyseMarket(text, sentences); break;
    case "email": part = analyseEmail(text, sentences); break;
    default: part = { facts: [], risks: [], opportunities: [] }; notes.push("Elena could not tell what kind of document this is, so she has only summarised it. No risk checks were run.");
  }
  if (wordCount < 60) notes.push("The document is very short, so the reading may be incomplete.");
  if (docClass !== "unknown" && part.risks.length === 0 && part.facts.length === 0) notes.push("Nothing specific was found. That does not mean there is nothing to find: scanned pages and images are not read.");
  const risks = [...part.risks].sort(bySeverity);
  const rating = rate(risks);
  const actionItems = [...(part.actionItems ?? [])];
  for (const r of risks.filter(x => x.severity !== "low")) actionItems.push({ text: r.action, priority: r.severity });
  const seen = new Set<string>();
  const dedupedActions = actionItems.filter(a => { const k = a.text.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => SEV_RANK[a.priority] - SEV_RANK[b.priority]).slice(0, 10);
  const keyPoints = keySentences(text, 5);
  const high = risks.filter(r => r.severity === "high").length, medium = risks.filter(r => r.severity === "medium").length;
  const headline = headlineFor(docClass, rating, high, medium, part.facts);
  const analysis: Analysis = {
    engine: ENGINE_VERSION, docClass, headline, rating, executiveSummary: "", keyPoints, facts: part.facts, risks,
    opportunities: part.opportunities, actionItems: dedupedActions, ...(part.cost ? { cost: part.cost } : {}), notes, disclaimer: DISCLAIMER, wordCount
  };
  analysis.executiveSummary = executiveSummary(analysis);
  return analysis;
}

function headlineFor(docClass: DocClass, rating: Rating, high: number, medium: number, facts: readonly Fact[]): string {
  if (docClass === "unknown") return "Summary only: document type not recognised";
  const lead = rating === "red" ? "Needs attention" : rating === "amber" ? "Some points to check" : "No major concerns found";
  const counts = high || medium ? ` (${[high ? `${high} high` : "", medium ? `${medium} medium` : ""].filter(Boolean).join(", ")})` : "";
  const price = docClass === "contract" ? facts.find(f => f.label === "Price") : undefined;
  return `${LABEL[docClass]}: ${lead}${counts}${price ? `, price ${price.value}` : ""}`;
}

/** Template-based summary in Elena's plain voice. Facts and counts come from the analysis, never invented. */
function executiveSummary(a: Analysis): string {
  const parts: string[] = [`${a.headline}.`];
  if (a.facts.length) parts.push(`Key numbers: ${a.facts.filter(f => f.kind !== "text").slice(0, 5).map(f => `${f.label} ${f.value}`).join("; ")}.`);
  const top = a.risks.filter(r => r.severity !== "low").slice(0, 3);
  if (top.length) parts.push(`Biggest concerns: ${top.map(r => r.title).join("; ")}.`);
  if (a.cost) parts.push(`Repairs flagged could cost about ${formatCents(a.cost.lowCents)} to ${formatCents(a.cost.highCents)} (${a.cost.basis === "stated" ? "figures stated in the report" : a.cost.basis === "mixed" ? "stated figures plus indicative ranges" : "indicative ranges only, get quotes"}).`);
  if (a.opportunities.length) parts.push(`In your favour: ${a.opportunities.slice(0, 2).map(o => o.title).join("; ")}.`);
  const first = a.actionItems[0];
  if (first) parts.push(`First step: ${first.text}`);
  return parts.join(" ");
}

/** Plain text for notices and email: summary, then flags and actions. */
export function renderSummaryText(a: Analysis, title: string): string {
  const lines = [`${title}`, "", a.executiveSummary, ""];
  if (a.risks.length) { lines.push("Flags:"); for (const r of a.risks) lines.push(`- [${r.severity.toUpperCase()}] ${r.title}: ${r.why}`); lines.push(""); }
  if (a.actionItems.length) { lines.push("Next steps:"); for (const x of a.actionItems) lines.push(`- ${x.text}${x.due ? ` (by ${x.due})` : ""}`); lines.push(""); }
  lines.push(a.disclaimer);
  return lines.join("\n");
}

// ---- Multi-document comparison --------------------------------------------------------------------------------------------------

export interface CompareInput { id: string; name: string; analysis: Analysis }
export interface CompareRow { label: string; values: (string | null)[]; /** Index of the column with the better value, where "better" is clear. */ best?: number }
export interface Comparison {
  docClass: DocClass | "mixed";
  columns: { id: string; name: string; rating: Rating }[];
  rows: CompareRow[];
  /** Risks that appear in only some documents: the differences worth a look. */
  differences: { riskId: string; title: string; severity: Severity; inDocs: number[] }[];
  shared: { riskId: string; title: string; severity: Severity }[];
  verdict: string;
}

const RATING_RANK: Record<Rating, number> = { green: 0, amber: 1, red: 2 };

/** Side by side for 2 to 6 documents. Same-type documents get term rows (price, deposit, settlement, repair cost); any mix gets flags. */
export function compareAnalyses(docs: readonly CompareInput[]): Comparison {
  const list = docs.slice(0, 6);
  const classes = new Set(list.map(d => d.analysis.docClass));
  const docClass: DocClass | "mixed" = classes.size === 1 ? (list[0]?.analysis.docClass ?? "unknown") : "mixed";
  const rows: CompareRow[] = [];
  const factRow = (label: string, lowerIsBetter?: boolean) => {
    const vals = list.map(d => d.analysis.facts.find(f => f.label === label));
    if (!vals.some(Boolean)) return;
    const nums = vals.map(v => v?.cents ?? v?.num);
    let best: number | undefined;
    if (lowerIsBetter !== undefined) {
      const def = nums.map((n, i) => [n, i] as const).filter((p): p is readonly [number, number] => p[0] !== undefined);
      if (def.length > 1) best = def.reduce((a, b) => (lowerIsBetter ? b[0] < a[0] : b[0] > a[0]) ? b : a)[1];
    }
    rows.push({ label, values: vals.map(v => v?.value ?? null), ...(best !== undefined ? { best } : {}) });
  };
  if (docClass === "contract" || docClass === "mixed") { factRow("Price"); factRow("Deposit", true); factRow("Settlement period"); factRow("Cooling-off period", false); factRow("Interest or penalty rate", true); }
  if (docClass === "market" || docClass === "mixed") for (const l of ["Median price", "Annual growth", "Days on market", "Clearance rate", "Rental yield", "Vacancy rate"]) factRow(l, l === "Days on market" || l === "Vacancy rate" ? true : l === "Median price" ? undefined : false);
  const costs = list.map(d => d.analysis.cost);
  if (costs.some(Boolean)) {
    const mids = costs.map(x => x ? (x.lowCents + x.highCents) / 2 : undefined);
    const def = mids.map((n, i) => [n, i] as const).filter((p): p is readonly [number, number] => p[0] !== undefined);
    rows.push({ label: "Repair cost range", values: costs.map(x => x ? `${formatCents(x.lowCents)} to ${formatCents(x.highCents)}` : null), ...(def.length > 1 ? { best: def.reduce((a, b) => b[0] < a[0] ? b : a)[1] } : {}) });
  }
  const highCounts = list.map(d => d.analysis.risks.filter(r => r.severity === "high").length);
  const bestHigh = indexOfMin(highCounts);
  rows.push({ label: "High flags", values: highCounts.map(String), ...(bestHigh !== undefined ? { best: bestHigh } : {}) });
  rows.push({ label: "Medium flags", values: list.map(d => String(d.analysis.risks.filter(r => r.severity === "medium").length)) });
  const all = new Map<string, { title: string; severity: Severity; inDocs: number[] }>();
  list.forEach((d, i) => { for (const r of d.analysis.risks) { const e = all.get(r.id) ?? { title: r.title, severity: r.severity, inDocs: [] }; e.inDocs.push(i); all.set(r.id, e); } });
  const entries = [...all.entries()].map(([riskId, e]) => ({ riskId, ...e }));
  const differences = entries.filter(e => e.inDocs.length < list.length).sort(bySeverity);
  const shared = entries.filter(e => e.inDocs.length === list.length && list.length > 1).sort(bySeverity).map(({ riskId, title, severity }) => ({ riskId, title, severity }));
  const columns = list.map(d => ({ id: d.id, name: d.name, rating: d.analysis.rating }));
  let verdict: string;
  if (list.length < 2) verdict = "Add at least two documents to compare.";
  else {
    const ranks = list.map(d => RATING_RANK[d.analysis.rating]);
    const lo = Math.min(...ranks);
    const bestIdx = list.map((_, i) => i).filter(i => ranks[i] === lo);
    const highs = list.map(d => d.analysis.risks.filter(r => r.severity === "high").length);
    verdict = bestIdx.length === 1
      ? `${list[bestIdx[0]!]?.name ?? "One document"} has the fewest serious flags (${highs[bestIdx[0]!]} high). Check the differences below before you decide.`
      : `${bestIdx.map(i => list[i]?.name).join(" and ")} look similar on risk. Compare the differences below.`;
    if (docClass === "mixed") verdict += " These are different kinds of documents, so only flags are compared.";
  }
  return { docClass, columns, rows, differences, shared, verdict };
}

const indexOfMin = (xs: readonly number[]): number | undefined => {
  if (xs.length < 2) return undefined;
  const min = Math.min(...xs);
  const idx = xs.map((x, i) => [x, i] as const).filter(p => p[0] === min);
  return idx.length === 1 ? idx[0]![1] : undefined;
};

// ---- Email digest ---------------------------------------------------------------------------------------------------------------

export interface DigestEmail { id: string; text: string }
export interface Digest {
  count: number;
  summary: string;
  flagged: { id: string; subject: string; risks: Finding[] }[];
  actions: { emailId: string; subject: string; text: string; priority: Severity; due?: string }[];
  items: { id: string; subject: string; rating: Rating; headline: string }[];
}
export const MAX_DIGEST_EMAILS = 50;

/** One digest across a batch of emails: scams first, then actions ordered by priority and due date. */
export function buildEmailDigest(emails: readonly DigestEmail[]): Digest {
  const items: Digest["items"] = [], flagged: Digest["flagged"] = [], actions: Digest["actions"] = [];
  for (const e of emails.slice(0, MAX_DIGEST_EMAILS)) {
    const use = analyseDocument(e.text, { forceClass: "email" });
    const subject = use.facts.find(f => f.label === "Subject")?.value ?? quote(e.text.split("\n", 1)[0] ?? "", 80);
    items.push({ id: e.id, subject, rating: use.rating, headline: use.headline });
    if (use.risks.some(r => r.severity !== "low")) flagged.push({ id: e.id, subject, risks: use.risks.filter(r => r.severity !== "low") });
    for (const x of use.actionItems) {
      if (use.risks.some(r => r.action === x.text)) continue;
      actions.push({ emailId: e.id, subject, text: x.text, priority: x.priority, ...(x.due ? { due: x.due } : {}) });
    }
  }
  actions.sort((a, b) => SEV_RANK[a.priority] - SEV_RANK[b.priority] || (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const n = items.length;
  const summary = n === 0 ? "No emails to read." : `${n} email${n === 1 ? "" : "s"} read. ${flagged.length ? `${flagged.length} need${flagged.length === 1 ? "s" : ""} care before you reply or pay anything. ` : "None looked risky. "}${actions.length ? `${actions.length} action${actions.length === 1 ? "" : "s"} found.` : "No actions found."}`;
  return { count: n, summary, flagged, actions: actions.slice(0, 40), items };
}
