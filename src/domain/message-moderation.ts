import { scanForDiscrimination, CATEGORY_LABELS } from "./discrimination-filter";

/**
 * Elena message moderation for the seller side of a thread (owner and appointed agent). Pure functions, rules only.
 * It advises: it never blocks a message and never edits one. (The anti-discrimination filter in enquiry-service still
 * blocks the clearest discrimination wording; this module explains it earlier, in the composer.)
 * Keyword and phrase matching is a starting map for Australian consumer rules. It is not legal advice and counsel reviews
 * the lists. ML tone analysis and pattern detection are left for later.
 */

export type ModerationCategory =
  | "discrimination" | "pressure_tactics" | "urgency_manipulation" | "off_platform_promise" | "financial_advice" | "legal_promise" | "tone";
export type ModerationSeverity = "low" | "medium" | "high";
export type ModerationRisk = "none" | ModerationSeverity;
export type Tone = "neutral" | "frustrated" | "aggressive";
export type ToneChoice = "professional" | "friendly" | "firm" | "accommodating";
export const TONE_CHOICES: readonly ToneChoice[] = ["professional", "friendly", "firm", "accommodating"];
export const isToneChoice = (v: unknown): v is ToneChoice => typeof v === "string" && (TONE_CHOICES as readonly string[]).includes(v);

export const MODERATION_RULES_VERSION = "message-moderation@1";

export interface ModerationFlag {
  category: ModerationCategory;
  severity: ModerationSeverity;
  match: string;
  /** Why this is a problem, in plain words (this is the training note the sender sees). */
  explanation: string;
  /** What to do instead. */
  suggestion: string;
}

export interface ModerationResult { risk: ModerationRisk; tone: Tone; flags: ModerationFlag[] }

interface Rule { category: Exclude<ModerationCategory, "discrimination" | "tone">; severity: ModerationSeverity; re: RegExp; explanation: string; suggestion: string }

const RULES: readonly Rule[] = [
  {
    category: "pressure_tactics", severity: "medium",
    re: /\b(you\s+must\s+(decide|answer|sign|accept)|act\s+now|last\s+chance|don'?t\s+miss\s+out|take\s+it\s+or\s+leave\s+it|final\s+warning|other\s+buyers?\s+(is|are)\s+(about\s+to|ready\s+to|waiting)|offer\s+(expires|ends|closes)\s+(today|tonight|in\s+\d+\s+(hours?|minutes?)))\b/,
    explanation: "Pressuring someone to decide quickly can be unfair conduct, and buyers have cooling-off and inspection rights.",
    suggestion: "Give a clear, reasonable date for a reply and say what happens next, without a threat."
  },
  {
    category: "urgency_manipulation", severity: "medium",
    re: /\b(today\s+only|now\s+or\s+never|hurry|before\s+it'?s\s+gone|won'?t\s+last|only\s+\d+\s+(hours?|minutes?|days?)\s+left|going\s+fast|prices?\s+(are\s+)?going\s+up\s+(tomorrow|next\s+week))\b/,
    explanation: "Creating false urgency can mislead a buyer into rushing a very large decision.",
    suggestion: "Only mention a deadline that is real (for example an auction or an offer's stated expiry date)."
  },
  {
    category: "off_platform_promise", severity: "high",
    re: /\b(whats\s*app|telegram|wechat|signal\s+app)\b|\b(call|text|email|message|contact)\s+me\s+(on|at|directly|privately)\b|\b(side|cash|private)\s+deal\b|\bunder\s+the\s+table\b|\bbetween\s+us\b|\b(off|outside)\s+(the\s+)?(platform|site|app)\b|\bavoid\s+(the\s+)?(fees?|commission|stamp\s+duty)\b|\bi\s+promise\s+(to|i'?ll)\b/,
    explanation: "Moving a deal or a promise off the platform removes the record that protects both sides. Deposits and contracts only go through the platform and the solicitor.",
    suggestion: "Keep the conversation and any commitments here, and point the buyer to the formal offer and their solicitor."
  },
  {
    category: "financial_advice", severity: "medium",
    re: /\b(you\s+should\s+(invest|borrow|refinance|take\s+out|use\s+(a|this)\s+(loan|lender|broker))|guaranteed\s+(return|profit|growth|rental\s+yield)|will\s+(double|triple)\s+in\s+value|(prices?|values?)\s+will\s+(definitely\s+)?(go\s+up|rise|boom)|can'?t\s+lose|best\s+investment|i\s+recommend\s+(this|that|a)\s+(loan|lender|broker|mortgage))\b/,
    explanation: "Financial advice and return guarantees need a licence, and predictions can mislead a buyer.",
    suggestion: "Stick to facts about the property and suggest the buyer speak to their own broker or financial adviser."
  },
  {
    category: "legal_promise", severity: "high",
    re: /\b(you\s+don'?t\s+need\s+(a\s+)?(solicitor|lawyer|conveyancer|inspection|building\s+report)|skip\s+(the\s+)?(inspection|cooling[-\s]?off|building\s+report)|waive\s+(the\s+)?(cooling[-\s]?off|inspection)|guarantee[d]?\s+(finance|settlement|approval|no\s+(defects|issues|problems))|no\s+(defects|issues|problems)\s+(at\s+all|whatsoever)|legally\s+binding\s+(now|already))\b/,
    explanation: "Discouraging a solicitor, inspection or cooling-off, or guaranteeing an outcome, can mislead the buyer about their rights and expose you to claims.",
    suggestion: "Encourage the buyer to get their own legal advice and inspection, and describe the property only as you know it."
  }
];

const HOSTILE_RE = /\b(idiots?|stupid|pathetic|useless|shut\s+up|liars?|scam(mer)?s?|lowball(ing)?|waste\s+of\s+(my\s+)?time|are\s+you\s+(serious|kidding|joking)|ridiculous|insulting|your\s+problem|fed\s+up|sick\s+of|don'?t\s+care|whatever|too\s+bad|get\s+lost|grow\s+up|damn|crap|bullshit|bloody\s+\w+)\b/;
const FRUSTRATED_RE = /\b(frustrat\w+|disappoint\w+|still\s+waiting|no\s+reply|ignor(e|ed|ing)\s+(me|my)|how\s+many\s+times|again\s+and\s+again|as\s+i\s+(already\s+)?(said|mentioned)|not\s+happy|unacceptable|confused)\b/;

const lower = (t: string) => t.normalize("NFKC").replace(/[\p{Cf}]/gu, "").replace(/\s+/g, " ").toLowerCase();

/** Shouting: several words of 3+ letters all in capitals, or a run of exclamation marks. */
function shouting(text: string): boolean {
  const caps = text.match(/\b[A-Z]{3,}\b/g) ?? [];
  return caps.length >= 3 || /[!?]{3,}/.test(text);
}

export function detectTone(text: string): Tone {
  const t = lower(text);
  if (HOSTILE_RE.test(t) || shouting(text)) return "aggressive";
  if (FRUSTRATED_RE.test(t)) return "frustrated";
  return "neutral";
}

const RANK: Record<ModerationRisk, number> = { none: 0, low: 1, medium: 2, high: 3 };
const maxRisk = (a: ModerationRisk, b: ModerationRisk): ModerationRisk => (RANK[a] >= RANK[b] ? a : b);

/** Checks a message before or after it is sent. Pure and fast. */
export function moderateMessage(text: string): ModerationResult {
  const t = lower(text);
  const flags: ModerationFlag[] = [];
  const dis = scanForDiscrimination(text).flags;
  const seenDis = new Set<string>();
  for (const f of dis) {
    if (seenDis.has(f.category)) continue;
    seenDis.add(f.category);
    flags.push({
      category: "discrimination", severity: f.severity === "block" ? "high" : "medium", match: f.match.slice(0, 80),
      explanation: `Wording about ${CATEGORY_LABELS[f.category]} can be unlawful discrimination in Australia. ${f.message}`,
      suggestion: f.suggestion
    });
  }
  for (const r of RULES) {
    const m = r.re.exec(t);
    if (m) flags.push({ category: r.category, severity: r.severity, match: m[0].slice(0, 80), explanation: r.explanation, suggestion: r.suggestion });
  }
  const tone = detectTone(text);
  if (tone !== "neutral") {
    flags.push({
      category: "tone", severity: tone === "aggressive" ? "medium" : "low", match: "",
      explanation: tone === "aggressive" ? "This reads as aggressive. Hostile messages can end a sale and may be used against you in a dispute." : "This reads as frustrated. A calmer message is more likely to get a reply.",
      suggestion: "Try one of the softer versions below."
    });
  }
  return { risk: flags.reduce<ModerationRisk>((r, f) => maxRisk(r, f.severity), "none"), tone, flags };
}

/** A pattern of flags is a reason to suggest training. Nothing is automated; staff decide. */
export const TRAINING_THRESHOLD = { flags: 3, days: 30 } as const;
export const needsTraining = (flagsInWindow: number): boolean => flagsInWindow >= TRAINING_THRESHOLD.flags;

// ---- Softer rewrites ----

const SOFTEN: readonly [RegExp, string][] = [
  [/\b(idiots?|stupid|pathetic|useless)\b/gi, ""],
  [/\b(lowball(ing)?)\b/gi, "low"],
  [/\bare\s+you\s+(serious|kidding|joking)\??/gi, "I was surprised by this"],
  [/\bwaste\s+of\s+(my\s+)?time\b/gi, "not a good use of our time"],
  [/\bridiculous\b/gi, "well below what we expected"],
  [/\binsulting\b/gi, "disappointing"],
  [/\b(take\s+it\s+or\s+leave\s+it)\b/gi, "this is my current position"],
  [/\b(act\s+now|hurry|last\s+chance|now\s+or\s+never)\b/gi, ""],
  [/\bwhatever\b/gi, ""],
  [/\b(you\s+must|you\s+have\s+to)\b/gi, "please"],
  [/\bas\s+i\s+(already\s+)?(said|mentioned)\b/gi, "to recap"],
  [/\bstill\s+waiting\b/gi, "looking forward to hearing from you"]
];

const OPEN: Record<ToneChoice, string> = { professional: "Hello,", friendly: "Hi there,", firm: "Hello,", accommodating: "Hi,", };
const CLOSE: Record<ToneChoice, string> = {
  professional: "Kind regards",
  friendly: "Thanks so much, and have a great day",
  firm: "To be clear, this is my position at the moment. I am happy to discuss it within these terms.",
  accommodating: "I am happy to work with you on this, so please let me know what would help."
};

/** Sentences that carry a serious concern are removed from the suggestion rather than reworded. */
const REMOVE: readonly ModerationCategory[] = ["discrimination", "off_platform_promise", "financial_advice", "legal_promise", "pressure_tactics", "urgency_manipulation"];

function sentencesOf(text: string): string[] {
  return text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
}

export interface Rewrite { tone: ToneChoice; text: string; removed: number }

/**
 * A softer version of the message in the chosen tone. Rules only: it removes sentences that raise a serious flag, calms
 * hostile words and shouting, and adds an opening and closing line. It never invents facts or numbers. Undefined when nothing is left.
 */
export function rewriteMessage(text: string, tone: ToneChoice): Rewrite | undefined {
  const kept: string[] = [];
  let removed = 0;
  for (const s of sentencesOf(text)) {
    const r = moderateMessage(s);
    if (r.flags.some(f => REMOVE.includes(f.category))) { removed++; continue; }
    let out = s;
    for (const [re, rep] of SOFTEN) out = out.replace(re, rep);
    if (shouting(out)) out = out.replace(/\b[A-Z]{3,}\b/g, w => w.toLowerCase());
    out = out.replace(/([!?])[!?]+/g, "$1").replace(/!+/g, ".").replace(/\s{2,}/g, " ").replace(/\s+([.,?])/g, "$1").trim();
    if (out && /[a-z0-9]/i.test(out)) kept.push(out.charAt(0).toUpperCase() + out.slice(1));
  }
  if (kept.length === 0) return undefined;
  return { tone, removed, text: `${OPEN[tone]}\n\n${kept.join(" ")}\n\n${CLOSE[tone]}` };
}

export const rewriteAll = (text: string): Rewrite[] => TONE_CHOICES.flatMap(t => rewriteMessage(text, t) ?? []);

// ---- Templates ----

export type TemplateScenario = "counter_offer" | "decline_offer" | "inspection_findings" | "set_expectations" | "negotiate_terms";
export interface MessageTemplate { id: string; scenario: TemplateScenario; label: string; body: string }

export const SCENARIO_LABEL: Record<TemplateScenario, string> = {
  counter_offer: "Counter an offer", decline_offer: "Decline an offer", inspection_findings: "Clarify inspection findings",
  set_expectations: "Set expectations", negotiate_terms: "Negotiate terms"
};

/** Fill the [brackets] before sending. The templates state no figures and make no promises. */
export const MESSAGE_TEMPLATES: readonly MessageTemplate[] = [
  { id: "counter-reasoned", scenario: "counter_offer", label: "Counter with reasons", body: "Hello [name],\n\nThank you for your offer of [their price]. After looking at it, I would like to counter at [counter price]. My reasons are [recent comparable sales / condition of the property / the timing you asked for]. The offer is open until [date and time]. I am happy to talk through any part of it.\n\nKind regards" },
  { id: "counter-terms", scenario: "counter_offer", label: "Counter on terms, not price", body: "Hello [name],\n\nThank you for your offer. The price works for me. I would like to ask for [settlement period / deposit / inclusions] to be [your preference] because [reason]. Would that work for you?\n\nKind regards" },
  { id: "decline-polite", scenario: "decline_offer", label: "Decline politely", body: "Hello [name],\n\nThank you for the time you put into your offer of [their price]. I have decided not to go ahead with it at this stage. If your situation changes I am happy to hear from you again. I wish you all the best with your search.\n\nKind regards" },
  { id: "decline-room", scenario: "decline_offer", label: "Decline but keep talking", body: "Hello [name],\n\nThank you for your offer of [their price]. It is below what I am able to accept at the moment, so I am not able to accept it as it stands. If you would like to submit a revised offer, I will consider it.\n\nKind regards" },
  { id: "inspection-clarify", scenario: "inspection_findings", label: "Clarify an inspection finding", body: "Hello [name],\n\nThank you for sending the inspection report. On [item in the report], here is what I know: [what you know, only facts you are sure of]. I do not have information about [anything you are unsure of]. If it would help, I am happy to arrange for [a licensed tradesperson / a second look] to check it. Please speak to your own adviser about what it means for you.\n\nKind regards" },
  { id: "expect-cooling-off", scenario: "set_expectations", label: "Explain cooling-off and next steps", body: "Hello [name],\n\nA quick note on what happens next. After contracts are exchanged, a cooling-off period may apply in [state]. The length and conditions are set out in the contract, so please confirm the details with your solicitor or conveyancer. The deposit is paid to the solicitor's trust account, never to me directly. I will update you at each step.\n\nKind regards" },
  { id: "expect-timeline", scenario: "set_expectations", label: "Share the timeline", body: "Hello [name],\n\nHere is the timeline as I understand it: [offer reply by date], [contracts by date], [settlement around date]. Dates can move if either side needs more time, and I will tell you straight away if mine change. Let me know if anything in it does not suit you.\n\nKind regards" },
  { id: "negotiate-terms", scenario: "negotiate_terms", label: "Negotiate a term", body: "Hello [name],\n\nOn [the term], I can move on [what you can give] if we can agree on [what you need in return]. That would let us both [shared benefit]. Does that sound workable?\n\nKind regards" }
];

export const templatesByScenario = (): Record<TemplateScenario, MessageTemplate[]> => {
  const out = {} as Record<TemplateScenario, MessageTemplate[]>;
  for (const k of Object.keys(SCENARIO_LABEL) as TemplateScenario[]) out[k] = MESSAGE_TEMPLATES.filter(t => t.scenario === k);
  return out;
};

// ---- Conversation monitoring ----

export const STALLED_AFTER_DAYS = 3;
export interface ThreadMessage { senderUserId: string | null; automated: boolean; body: string; sentAt: string }

export interface ConversationInsight {
  stalled?: { days: number; waitingOn: "buyer" | "seller"; followUps: { tone: ToneChoice; text: string }[] };
  toneShift?: { by: "buyer" | "seller"; tone: Tone };
}

const FOLLOW_UP: Record<ToneChoice, string> = {
  professional: "Hello [name],\n\nI am following up on my last message. Please let me know if you have any questions or if there is anything I can clarify.\n\nKind regards",
  friendly: "Hi [name],\n\nJust checking in. No rush, but I would love to hear your thoughts when you have a moment.\n\nThanks so much",
  firm: "Hello [name],\n\nI am following up on my message of [date]. I would appreciate a reply by [date] so we can both plan.\n\nKind regards",
  accommodating: "Hi [name],\n\nI wanted to check in in case my last message got buried. If anything is unclear or the timing is hard, I am happy to adjust.\n\nKind regards"
};

/**
 * Looks at a thread from the seller's side. Stalled: the last real message is older than 3 days (waiting on the buyer when the seller
 * wrote last, otherwise the buyer is waiting on the seller). Tone shift: the latest message from one side is hostile or frustrated
 * after earlier messages from that side were neutral.
 */
export function analyseConversation(messages: readonly ThreadMessage[], buyerUserId: string, nowIso: string): ConversationInsight {
  const human = messages.filter(m => !m.automated && m.senderUserId).sort((a, b) => (a.sentAt < b.sentAt ? -1 : 1));
  const out: ConversationInsight = {};
  const last = human[human.length - 1];
  if (!last) return out;
  const days = Math.floor((Date.parse(nowIso) - Date.parse(last.sentAt)) / 86_400_000);
  if (days > STALLED_AFTER_DAYS) {
    out.stalled = { days, waitingOn: last.senderUserId === buyerUserId ? "seller" : "buyer", followUps: TONE_CHOICES.map(tone => ({ tone, text: FOLLOW_UP[tone] })) };
  }
  const side = (m: ThreadMessage): "buyer" | "seller" => (m.senderUserId === buyerUserId ? "buyer" : "seller");
  const mine = human.filter(m => side(m) === side(last));
  const lastTone = detectTone(last.body);
  if (lastTone !== "neutral" && mine.length >= 2 && mine.slice(0, -1).every(m => detectTone(m.body) === "neutral")) {
    out.toneShift = { by: side(last), tone: lastTone };
  }
  return out;
}
