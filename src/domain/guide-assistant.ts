import { isEngineUsable, type AiEnginePort } from "./ai-engine";
import { answerGuideQuestion } from "./guide-ai";
import type { JourneyStep } from "./journey";

/**
 * The guide assistant (chat widget on every public page). Rule based: a fixed set of intents, each mapped to an answer (editable by
 * staff at /staff/assistant) and "take me there" links (fixed here, never editable and never produced by AI). Pure functions only.
 * It explains how to use the website. It never gives legal, financial or tax advice, never accepts or rejects offers, and never
 * reveals anything about another user. Visitor messages are not stored anywhere.
 */
export type GuideUser = "signed_out" | "owner" | "buyer" | "agent";
export const GUIDE_INTENTS = [
  "next_step", "how_to_list", "documents", "verification", "offers", "fees", "enquire", "saved_searches", "dashboard", "support"
] as const;
export type GuideIntent = (typeof GUIDE_INTENTS)[number];
export const isGuideIntent = (v: unknown): v is GuideIntent => typeof v === "string" && (GUIDE_INTENTS as readonly string[]).includes(v);

export interface GuideLink { label: string; href: string }
export interface GuideChip { intent: GuideIntent; label: string }
export interface GuideFaq { question: string; answer: string }
export interface GuideContent {
  enabled: boolean;
  greeting: string;
  chips: GuideChip[];
  faq: Record<GuideIntent, GuideFaq>;
  support: { text: string; href: string | null };
}

export const GUIDE_LIMITS = { greeting: 300, chipLabel: 40, chips: 8, question: 120, answer: 700, supportText: 300, url: 300, message: 500 } as const;

/** Shown under every answer. Fixed in code so it cannot be edited away. */
export const GUIDE_DISCLAIMER =
  "General help with using this website only. Not legal, financial or tax advice. For advice about your situation, speak to a solicitor, conveyancer or licensed adviser.";
const ADVICE_ANSWER =
  "I can't give legal, financial, tax or valuation advice, or tell you whether to buy, sell or accept an offer. A solicitor or conveyancer can advise on contracts, and a licensed financial adviser or broker on money. I can show you how the website works.";
const PRIVACY_ANSWER =
  "I can't share anything about other people, such as an owner's or buyer's contact details. To contact an owner, open their listing and press Enquire; your messages go through the secure chat.";
const UNKNOWN_ANSWER = "Sorry, I didn't catch that. Choose one of the topics below, or ask about listing, offers, fees, verification or enquiries.";

export const DEFAULT_GUIDE: GuideContent = {
  enabled: true,
  greeting: "Hi! I can show you how to list your home, how offers work, or what to do next. I give set answers and I'm not a person.",
  chips: [
    { intent: "next_step", label: "What should I do next?" },
    { intent: "how_to_list", label: "How do I list my home?" },
    { intent: "offers", label: "How do offers work?" },
    { intent: "fees", label: "What does it cost?" },
    { intent: "verification", label: "How does verification work?" },
    { intent: "enquire", label: "How do I enquire?" },
    { intent: "documents", label: "What documents do I need?" },
    { intent: "support", label: "Talk to support" }
  ],
  faq: {
    next_step: { question: "What should I do next?", answer: "Owners: sign in and press List a property. Buyers and renters: browse listings, then verify once so you can enquire and make offers." },
    how_to_list: { question: "How do I list my home myself?", answer: "Sign in, press List a property and fill in the details. Your listing is saved as a draft. Add photos, choose a plan, and it goes live once your solicitor's trust account is verified and the publishing checks pass." },
    documents: { question: "What documents do I need?", answer: "Your property details and photos, plus the documents your state requires before marketing, such as a contract of sale or disclosure statement from your solicitor or conveyancer. The listing form shows what is needed for your state. Published files can be replaced with a new version but never deleted." },
    verification: { question: "How does verification work?", answer: "Buyers verify their email, mobile and ID once, from the Verification page, and can then enquire and make offers on any listing. For owners, staff check the solicitor's trust account that will receive the deposit before a listing can go live." },
    offers: { question: "How do offers work?", answer: "A verified buyer gets a secure offer link in the enquiry chat and submits the offer through the website. The owner reviews every offer and decides to accept, counter or decline. AI can summarise an offer but never accepts one." },
    fees: { question: "What does it cost?", answer: "Plans and fees are published on the Plans page, with GST shown. There is no commission. The platform never holds deposits: they go to the solicitor's trust account." },
    enquire: { question: "How do I contact an owner?", answer: "Open a listing and press Enquire. You need a buyer account and a verified email. Messages go to the owner in a secure chat that is kept as a record and cannot be deleted." },
    saved_searches: { question: "Can I get alerts for new listings?", answer: "Yes. Buyers can save a search from Saved searches and choose email or SMS alerts for new matching listings." },
    dashboard: { question: "Where is my dashboard?", answer: "Your dashboard shows your progress and your tasks. Sign in to see it." },
    support: { question: "How do I talk to a person?", answer: "For help from a person, use the support contact below. Please don't send ID documents or bank details by chat or email." }
  },
  support: { text: "Support contact details will be published here.", href: null }
};

// ---- Validation (staff edits). Plain text only, length caps, https or same-site links. ----
export type GuideErrors = Record<string, string>;
export type GuideResult = { ok: true; value: GuideContent } | { ok: false; errors: GuideErrors };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const PLAIN = /^[^\u0000-\u0009\u000b-\u001f\u007f<>{}`]*$/;
const URL_CHARS = /^[^\s<>"'`\\\u0000-\u001f\u007f]+$/;

function text(v: unknown, max: number, path: string, errors: GuideErrors, allowEmpty = false): string | null {
  if (typeof v !== "string") { errors[path] = "Must be text."; return null; }
  const t = v.trim();
  if (!t && !allowEmpty) { errors[path] = "Required."; return null; }
  if (t.length > max) { errors[path] = `At most ${max} characters.`; return null; }
  if (!PLAIN.test(t)) { errors[path] = "Plain text only: no HTML, braces, backticks or control characters."; return null; }
  return t;
}

/** https URL (no credentials) or a same-site path; anything else is null. */
export function guideLink(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > GUIDE_LIMITS.url || !URL_CHARS.test(s)) return null;
  if (s.startsWith("/")) return s.startsWith("//") || s.startsWith("/\\") ? null : s;
  if (!/^https:\/\/[a-z0-9]/i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.username === "" && u.password === "" ? s : null;
  } catch {
    return null;
  }
}

function keys(o: Record<string, unknown>, allowed: readonly string[], path: string, errors: GuideErrors) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors[path ? `${path}.${k.slice(0, 40)}` : k.slice(0, 40)] = "Unknown field.";
  for (const k of allowed) if (!(k in o)) errors[path ? `${path}.${k}` : k] = "Missing.";
}

export function validateGuideContent(input: unknown): GuideResult {
  const errors: GuideErrors = {};
  if (!isObj(input)) return { ok: false, errors: { "": "Send a content object." } };
  keys(input, ["enabled", "greeting", "chips", "faq", "support"], "", errors);
  if (typeof input["enabled"] !== "boolean") errors["enabled"] = "Must be true or false.";
  const greeting = text(input["greeting"], GUIDE_LIMITS.greeting, "greeting", errors);

  const chips: GuideChip[] = [];
  const rawChips = input["chips"];
  if (!Array.isArray(rawChips)) errors["chips"] = "Must be a list.";
  else if (rawChips.length < 1 || rawChips.length > GUIDE_LIMITS.chips) errors["chips"] = `Between 1 and ${GUIDE_LIMITS.chips} quick replies.`;
  else {
    const seen = new Set<string>();
    rawChips.forEach((c, i) => {
      const p = `chips.${i}`;
      if (!isObj(c)) { errors[p] = "Invalid quick reply."; return; }
      keys(c, ["intent", "label"], p, errors);
      if (!isGuideIntent(c["intent"]) || seen.has(c["intent"])) { errors[`${p}.intent`] = "Unknown or repeated topic."; return; }
      seen.add(c["intent"]);
      const label = text(c["label"], GUIDE_LIMITS.chipLabel, `${p}.label`, errors);
      if (label !== null) chips.push({ intent: c["intent"], label });
    });
  }

  const faq = {} as Record<GuideIntent, GuideFaq>;
  const rawFaq = input["faq"];
  if (!isObj(rawFaq)) errors["faq"] = "Missing.";
  else {
    keys(rawFaq, GUIDE_INTENTS, "faq", errors);
    for (const intent of GUIDE_INTENTS) {
      const f = rawFaq[intent];
      if (!isObj(f)) { errors[`faq.${intent}`] = "Missing."; continue; }
      keys(f, ["question", "answer"], `faq.${intent}`, errors);
      const question = text(f["question"], GUIDE_LIMITS.question, `faq.${intent}.question`, errors);
      const answer = text(f["answer"], GUIDE_LIMITS.answer, `faq.${intent}.answer`, errors);
      if (question !== null && answer !== null) faq[intent] = { question, answer };
    }
  }

  let support: GuideContent["support"] | null = null;
  const rs = input["support"];
  if (!isObj(rs)) errors["support"] = "Missing.";
  else {
    keys(rs, ["text", "href"], "support", errors);
    const t = text(rs["text"], GUIDE_LIMITS.supportText, "support.text", errors);
    let href: string | null = null;
    if (rs["href"] !== null && rs["href"] !== "") {
      href = guideLink(rs["href"]);
      if (href === null) errors["support.href"] = "Use an https:// link or a path starting with / on this site, or leave empty.";
    }
    if (t !== null) support = { text: t, href };
  }

  if (Object.keys(errors).length > 0 || greeting === null || !support || typeof input["enabled"] !== "boolean") {
    return { ok: false, errors: Object.keys(errors).length > 0 ? errors : { "": "Invalid content." } };
  }
  return { ok: true, value: { enabled: input["enabled"], greeting, chips, faq, support } };
}

/** Stored content that no longer validates falls back to the defaults, so a bad row can never reach a visitor. */
export function parseStoredGuide(raw: unknown): GuideContent {
  const r = validateGuideContent(typeof raw === "string" ? safeJson(raw) : raw);
  return r.ok ? r.value : structuredClone(DEFAULT_GUIDE);
}
const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

// ---- Page context and intent matching ----
export type GuidePage = "home" | "browse" | "listing" | "new_listing" | "my_listings" | "plans" | "dashboard" | "buyer" | "enquiries" | "other";

export function guidePage(path: unknown): GuidePage {
  if (typeof path !== "string" || !path.startsWith("/")) return "other";
  const p = path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  if (p === "/") return "home";
  if (p === "/listings") return "browse";
  if (p === "/listings/new") return "new_listing";
  if (p === "/listings/mine") return "my_listings";
  if (/^\/listings\/[^/]+/.test(p)) return "listing";
  if (p === "/plans") return "plans";
  if (p === "/dashboard") return "dashboard";
  if (p.startsWith("/buyer")) return "buyer";
  if (p.startsWith("/enquiries")) return "enquiries";
  return "other";
}

/** Topics that matter most on each page come first. */
const PAGE_FIRST: Record<GuidePage, readonly GuideIntent[]> = {
  home: ["next_step", "how_to_list"],
  browse: ["enquire", "saved_searches"],
  listing: ["enquire", "offers"],
  new_listing: ["documents", "how_to_list", "fees"],
  my_listings: ["offers", "next_step"],
  plans: ["fees"],
  dashboard: ["next_step"],
  buyer: ["verification", "saved_searches"],
  enquiries: ["offers", "enquire"],
  other: []
};

/** The staff-configured quick replies, re-ordered for the page. */
export function suggestedChips(content: Pick<GuideContent, "chips">, path: unknown): GuideChip[] {
  const first = PAGE_FIRST[guidePage(path)];
  const rank = (c: GuideChip) => { const i = first.indexOf(c.intent); return i === -1 ? first.length : i; };
  return content.chips.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(x => x.c);
}

export type MatchedIntent = GuideIntent | "advice" | "privacy" | "unknown";

const PRIVACY_RE = /\b((phone|mobile|email|address|number|name|details?)\s+(of|for)\s+(the\s+|this\s+|that\s+)?(owner|seller|vendor|buyer|landlord|user|person)|(owner|seller|vendor|buyer|landlord)'?s\s+(phone|mobile|email|number|address|details?)|who\s+(owns|is\s+selling|is\s+the\s+(buyer|owner|seller))|other\s+(users?|buyers?|people)'?s?)\b/i;
const ADVICE_RE = /\b(should\s+i\s+(buy|sell|accept|reject|counter|sign|offer|rent|lease)|legal(ly)?\s+advice|is\s+(it|this|the|my)\s+(\w+\s+)?legal|(financial|tax|investment)\s+advice|stamp\s+duty|capital\s+gains|cgt|how\s+much\s+(can|could)\s+i\s+(borrow|afford|get)|borrow|afford|mortgage|loan|good\s+(deal|price|investment)|worth\s+(it|buying)|what\s+is\s+my\s+(home|house|property)\s+worth|valuation|value\s+my)\b/i;

const KEYWORDS: readonly [GuideIntent, RegExp][] = [
  ["next_step", /\b(next|what\s+now|where\s+do\s+i\s+start|get\s+started|start|begin)\b/i],
  ["how_to_list", /\b(list|listing|sell|selling|advertise|rent\s+out|put\s+my\s+(home|house|property))\b/i],
  ["documents", /\b(documents?|papers?|contract|disclosure|section\s+32|form\s+\d|files?|photos?|upload)\b/i],
  ["verification", /\b(verif\w*|identity|id\s+check|\bid\b|kyc|trust\s+account)\b/i],
  ["offers", /\b(offers?|accept|counter|bid|negotiat\w*)\b/i],
  ["fees", /\b(fees?|cost|costs|price\s+plan|plans?|pricing|commission|how\s+much\s+(is|does)|pay)\b/i],
  ["enquire", /\b(enquir\w*|inquir\w*|contact\s+(the\s+)?owner|message|chat|inspect\w*)\b/i],
  ["saved_searches", /\b(saved?\s+search\w*|alerts?|notify|notification)\b/i],
  ["dashboard", /\b(dashboard|my\s+account|account|sign\s*in|log\s*in)\b/i],
  ["support", /\b(support|help\s+desk|human|person|someone|complain\w*|staff|contact\s+us)\b/i]
];

/** Deterministic: privacy and advice questions are caught first, then the topic with the most keyword hits (ties: list order). */
export function matchIntent(input: unknown): MatchedIntent {
  if (typeof input !== "string") return "unknown";
  const t = input.slice(0, GUIDE_LIMITS.message);
  if (PRIVACY_RE.test(t)) return "privacy";
  if (ADVICE_RE.test(t)) return "advice";
  let best: GuideIntent | null = null, bestHits = 0;
  for (const [intent, re] of KEYWORDS) {
    const hits = (t.match(new RegExp(re.source, "gi")) ?? []).length;
    if (hits > bestHits) { best = intent; bestHits = hits; }
  }
  return best ?? "unknown";
}

// ---- Answers ----
export interface GuideQuery {
  intent?: GuideIntent;
  text?: string;
  path: string;
  user: GuideUser;
  /** For next_step: the signed-in user's first open journey step (their own data only), or null. */
  next?: JourneyStep | null;
  /** Where "Sign in" points (the dev sign-in page only when devLoginAllowed). */
  signInHref?: string;
}
export interface GuideAnswer { intent: MatchedIntent; text: string; links: GuideLink[]; chips: GuideChip[]; disclaimer: string; source: "rules" | "ai" }

const SIGN_IN = "/api/auth/google/start";

function linksFor(intent: GuideIntent, q: GuideQuery, content: GuideContent): GuideLink[] {
  const signIn: GuideLink = { label: "Sign in", href: q.signInHref ?? SIGN_IN };
  const out = q.user === "signed_out";
  const seller = q.user === "owner" || q.user === "agent";
  const buyer = q.user === "buyer";
  switch (intent) {
    case "next_step":
      if (q.next) return [{ label: q.next.label, href: q.next.href }, { label: "Open my dashboard", href: "/dashboard" }];
      if (out) return [{ label: "List your property", href: "/listings/new" }, { label: "Browse listings", href: "/listings" }, signIn];
      return [{ label: "Open my dashboard", href: "/dashboard" }];
    case "how_to_list":
      return buyer ? [{ label: "Browse listings", href: "/listings" }] : [{ label: "List a property", href: "/listings/new" }, { label: "See plans and fees", href: "/plans" }];
    case "documents":
      return seller ? [{ label: "My listings", href: "/listings/mine" }] : [{ label: "List a property", href: "/listings/new" }];
    case "verification":
      return buyer ? [{ label: "Verify my account", href: "/buyer/verification" }] : seller ? [{ label: "My listings", href: "/listings/mine" }] : [signIn];
    case "offers":
      return seller ? [{ label: "Review offers on my listings", href: "/listings/mine" }] : buyer ? [{ label: "My enquiries", href: "/enquiries" }] : [{ label: "Browse listings", href: "/listings" }];
    case "fees":
      return [{ label: "See plans and fees", href: "/plans" }];
    case "enquire":
      return buyer ? [{ label: "Browse listings", href: "/listings" }, { label: "My enquiries", href: "/enquiries" }] : [{ label: "Browse listings", href: "/listings" }];
    case "saved_searches":
      return buyer ? [{ label: "Saved searches", href: "/buyer/saved-searches" }] : out ? [signIn] : [{ label: "Browse listings", href: "/listings" }];
    case "dashboard":
      return out ? [signIn] : [{ label: "Open my dashboard", href: "/dashboard" }];
    case "support":
      return content.support.href ? [{ label: "Contact support", href: content.support.href }] : [];
  }
}

function textFor(intent: GuideIntent, q: GuideQuery, content: GuideContent): string {
  const base = content.faq[intent].answer;
  if (intent === "next_step" && q.next) return `Your next step: ${q.next.label}. ${q.next.hint}`;
  if (intent === "next_step" && q.user !== "signed_out") return "You're all set for now. Your dashboard lists your tasks.";
  if (intent === "how_to_list" && q.user === "buyer") return "Listing needs an owner account; your account is a buyer account. You can still browse, enquire and make offers.";
  if (intent === "support") return `${base} ${content.support.text}`;
  return base;
}

const otherChips = (content: GuideContent, q: GuideQuery, not: MatchedIntent): GuideChip[] =>
  suggestedChips(content, q.path).filter(c => c.intent !== not).slice(0, 4);

/**
 * The rules answer for a topic or a typed question. Never reads or returns other users' data. An advice or privacy question in the
 * typed text is refused even when a topic id is also sent, so a client cannot pair a topic with such text to reach the AI.
 */
export function guideAnswer(content: GuideContent, q: GuideQuery): GuideAnswer {
  const fromText = matchIntent(q.text ?? "");
  const intent: MatchedIntent = fromText === "advice" || fromText === "privacy" ? fromText : q.intent && isGuideIntent(q.intent) ? q.intent : fromText;
  const base = { disclaimer: GUIDE_DISCLAIMER, source: "rules" as const };
  if (intent === "advice") return { ...base, intent, text: ADVICE_ANSWER, links: [], chips: otherChips(content, q, intent) };
  if (intent === "privacy") return { ...base, intent, text: PRIVACY_ANSWER, links: [{ label: "Browse listings", href: "/listings" }], chips: otherChips(content, q, intent) };
  if (intent === "unknown") return { ...base, intent, text: UNKNOWN_ANSWER, links: [], chips: suggestedChips(content, q.path) };
  return { ...base, intent, text: textFor(intent, q, content), links: linksFor(intent, q, content), chips: otherChips(content, q, intent) };
}

// ---- Engine port: rules now, the self-hosted AI later ----
export interface AssistantEngine { readonly id: "rules" | "ai"; answer(q: GuideQuery): Promise<GuideAnswer> }

export const rulesAssistant = (content: GuideContent): AssistantEngine => ({ id: "rules", answer: async q => guideAnswer(content, q) });

/**
 * The self-hosted AI behind the same port, through the shared guide hook (answerGuideQuestion in guide-ai.ts: its own scope prompt,
 * offer-action and advice refusals, output checks, fail closed). It only rewrites the answer text for a typed question: the topic,
 * links and chips still come from the rules (AI never produces a link or an action). Advice and privacy questions are answered by
 * the rules first and never reach the model. Anything other than a checked answer without links or markup falls back to the rules.
 */
export function aiAssistant(ai: AiEnginePort, rules: AssistantEngine, siteName: string): AssistantEngine {
  return {
    id: "ai",
    async answer(q) {
      const fallback = await rules.answer(q);
      if (!q.text || fallback.intent === "advice" || fallback.intent === "privacy") return fallback;
      const r = await answerGuideQuestion(q.text, { engine: ai, siteName, page: q.path });
      if (r.state === "refused") return { ...fallback, text: r.message };
      if (r.state !== "ready" || /[<>{}`]|https?:\/\/|www\./i.test(r.text) || /\boffers?\s+(is|are|was|were|has\s+been|have\s+been)\s+(accepted|declined|rejected)\b/i.test(r.text)) return fallback;
      return { ...fallback, text: r.text, source: "ai" };
    }
  };
}

/** The AI is used only when the self-hosted engine is configured and switched on at /staff/ai (off by default); otherwise the rules guide. */
export function selectAssistantEngine(ai: AiEnginePort, content: GuideContent, siteName: string): AssistantEngine {
  const rules = rulesAssistant(content);
  return isEngineUsable(ai) ? aiAssistant(ai, rules, siteName) : rules;
}

/** The FAQ entries shown on the home page (same staff-edited answers as the assistant). */
export const HOME_FAQ_INTENTS: readonly GuideIntent[] = ["how_to_list", "fees", "offers", "verification", "documents", "enquire"];
