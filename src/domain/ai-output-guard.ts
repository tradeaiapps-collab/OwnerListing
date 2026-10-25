import { CONTACT_RE } from "./ai-engine";
import { stripFooter, type WordingFilter } from "./ai-pipeline";
import { checkPublicOutput } from "./ai-public-guard";

/**
 * The guard every buyer-facing AI draft passes before an owner can send it as is (spec 5.1 "Guard").
 * It is a backstop: prompts and evaluation sets are the first line. A failed draft is kept as "held" with the reasons;
 * nothing is sent.
 */

export type GuardCode =
  | "empty" | "too_long" | "contact_details" | "financial_advice" | "wording_filter" | "wording_filter_missing"
  | "floor_leak" | "binding_language" | "false_urgency" | "other_buyers" | "unknown_amount" | "personal_characteristics";

export interface GuardViolation { code: GuardCode; message: string }
export interface DraftGuardResult { ok: boolean; violations: GuardViolation[] }

export interface DraftGuardContext {
  wordingFilter: WordingFilter;
  /** Server-side only, never in a prompt. Used to catch a draft that states the confidential floor. */
  floorPriceCents?: number;
  /** Every dollar amount the draft may mention (asking price, the offer, a counter the owner is shown). */
  allowedAmountsCents: readonly number[];
  /** True when the owner chose to say there are other offers. Otherwise any such claim is refused (spec 5.3). */
  ownerAllowsOtherOffersMention?: boolean;
  maxChars?: number;
}

const MAX_DRAFT_CHARS = 2500;

/** Words that sound like the seller is bound or the deal is done. The AI never accepts (CLAUDE.md, spec 5.3). */
const BINDING = /\b(we|i|the (seller|owner|vendor)s?)\s+(have\s+|has\s+|will\s+|would\s+|can\s+|hereby\s+)?(accept(ed)?|agree(d)?\s+to\s+(sell|lease|rent|your)|approve(d)?\s+your)\b|\byou(['’]ve| have)?\s+got\s+(a|the)\s+(deal|house|property)\b|\b(it'?s|that'?s)\s+a\s+deal\b|\bsold\s+to\s+you\b|\bthe\s+(property|house|home|place)\s+is\s+yours\b|\boffer\s+(is\s+)?accepted\b|\bconsider\s+it\s+(sold|done)\b/i;

/** Floor, reserve or "lowest price" talk. The number itself is also checked when the server passes it. */
const FLOOR_WORDS = /\b(floor\s+price|reserve\s+price|our\s+reserve|the\s+reserve|walk-?away\s+price|bottom\s+line|lowest\s+(price\s+)?(we|they|the\s+(seller|owner|vendor))\s+(will|would|can)\s+(take|accept|go)|minimum\s+(we|they|the\s+(seller|owner))\s+(will|would)\s+accept)\b/i;

const URGENCY = /\b(act\s+(now|fast|quickly)|before\s+it'?s\s+too\s+late|won'?t\s+last|last\s+chance|today\s+only|offers?\s+close\s+(today|tonight|tomorrow)|must\s+decide\s+(today|now|within))\b/i;
const OTHER_BUYERS = /\b(other|another|several|multiple|competing|higher|better)\s+(offers?|buyers?|bids?|parties|interested\s+parties)\b|\bsomeone\s+else\s+(has\s+)?(offered|bid)\b/i;

/** The draft talks about a person's characteristics (spec 5.3: never discuss a buyer's family, origin or age). */
const PERSONAL = /\b(your|their)\s+(age|religion|ethnicity|race|nationality|accent|family\s+situation|marital\s+status|pregnan\w*|disability|kids|children)\b/i;

// $850,000 / $850k / $1.2m / $650 per week. Each match becomes cents for the fact check.
const AMOUNT_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(k|m|mil|million)?\b/gi;

export function amountsInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const whole = Number(m[1]!.replace(/,/g, ""));
    const cents = Number((m[2] ?? "").padEnd(2, "0"));
    const unit = (m[3] ?? "").toLowerCase();
    const mult = unit === "k" ? 1_000 : unit.startsWith("m") ? 1_000_000 : 1;
    out.push(Math.round((whole + cents / 100) * mult * 100));
  }
  return out;
}

/** An amount matches an allowed one within $1 or 0.1% (rounding in prose, "$1.2m" for $1,195,000 is NOT a match). */
function allowed(amount: number, list: readonly number[]): boolean {
  return list.some(a => Math.abs(a - amount) <= Math.max(100, a * 0.001));
}

/** Digits in the text that spell the floor ("845000", "845,000", "$845k"). */
function mentionsNumber(text: string, cents: number): boolean {
  if (amountsInText(text).some(a => Math.abs(a - cents) <= Math.max(100, cents * 0.001))) return true;
  const dollars = Math.round(cents / 100);
  const plain = text.replace(/[,\s]/g, "");
  return dollars >= 1000 && new RegExp(`(^|\\D)${dollars}(\\D|$)`).test(plain);
}

export function guardDraft(text: string, ctx: DraftGuardContext): DraftGuardResult {
  const v: GuardViolation[] = [];
  const add = (code: GuardCode, message: string) => v.push({ code, message });
  const body = stripFooter(text);
  if (body.trim().length === 0) add("empty", "The draft is empty.");
  if (body.length > (ctx.maxChars ?? MAX_DRAFT_CHARS)) add("too_long", "The draft is too long.");
  if (CONTACT_RE.test(body)) add("contact_details", "The draft contains contact details or a link.");
  const pub = checkPublicOutput(body);
  if (!pub.ok) add("financial_advice", pub.violations.join(" "));
  const wf = ctx.wordingFilter(body);
  if (!wf.installed) add("wording_filter_missing", "The anti-discrimination wording filter is not installed yet, so AI text cannot be checked.");
  else if (wf.blocked || wf.flags.length > 0) add("wording_filter", `Wording that may be discriminatory: ${wf.flags.map(f => `"${f.match}"`).join(", ") || "flagged"}.`);
  // A counter the owner is shown may sit exactly on the floor; that amount is an allowed one, not a leak.
  const floorNumber = ctx.floorPriceCents !== undefined && !allowed(ctx.floorPriceCents, ctx.allowedAmountsCents) ? ctx.floorPriceCents : undefined;
  if (FLOOR_WORDS.test(body) || (floorNumber !== undefined && mentionsNumber(body, floorNumber))) {
    add("floor_leak", "The draft could reveal the confidential lowest price.");
  }
  if (BINDING.test(body)) add("binding_language", "The draft sounds like an acceptance or a promise. Only the seller accepts, in their own step.");
  if (URGENCY.test(body)) add("false_urgency", "The draft creates pressure or urgency.");
  if (!ctx.ownerAllowsOtherOffersMention && OTHER_BUYERS.test(body)) add("other_buyers", "The draft mentions other buyers or offers.");
  if (PERSONAL.test(body)) add("personal_characteristics", "The draft refers to a person's characteristics.");
  const unknown = amountsInText(body).filter(a => !allowed(a, ctx.allowedAmountsCents));
  if (unknown.length > 0) add("unknown_amount", "The draft states an amount that is not in the listing or the offer.");
  return { ok: v.length === 0, violations: v };
}
