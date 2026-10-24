import { staffCan, type StaffActor } from "./staff-access";

/**
 * Posting models, contact masking, the signed-contract state machine and the platform fee. Pure.
 * The platform never receives or holds investor money: the Model 1 fee is invoiced to the poster after the signed contract
 * comes back, and is never deducted from investment funds. Counsel must review both models (docs/COUNSEL_QUESTIONS.md 9).
 */

export type PostingModel = "commission_on_contract" | "upfront_fee";
export const POSTING_MODELS: readonly PostingModel[] = ["commission_on_contract", "upfront_fee"];
export type CommissionType = "percent" | "fixed";
export type Model2Disclosure = "off" | "after_fee" | "after_contract";
export const MODEL2_DISCLOSURE: readonly Model2Disclosure[] = ["off", "after_fee", "after_contract"];

export interface PostingSettings {
  model: PostingModel;
  commissionType: CommissionType;
  /** Basis points of the contract amount (100 = 1%). */
  commissionBps: number;
  commissionFixedCents: number;
  upfrontFeeCents: number;
  /** Model 2 only: when the poster's contact details may be shown to investors. */
  model2Disclosure: Model2Disclosure;
}

export const DEFAULT_POSTING: PostingSettings = {
  model: "commission_on_contract", commissionType: "percent", commissionBps: 0, commissionFixedCents: 0, upfrontFeeCents: 0, model2Disclosure: "off"
};

/** Copied onto each project when it is posted. Later settings changes apply to new projects only. */
export interface PostingTerms {
  model: PostingModel;
  commissionType: CommissionType;
  commissionBps: number;
  commissionFixedCents: number;
  upfrontFeeCents: number;
  upfrontFeeStatus: "not_required" | "unpaid" | "paid";
  /** Model 2 disclosure rule agreed when posted ("off" under Model 1). A later admin change never opens contacts on an existing project. */
  model2Disclosure: Model2Disclosure;
}

export const termsFrom = (s: PostingSettings): PostingTerms => s.model === "commission_on_contract"
  ? { model: s.model, commissionType: s.commissionType, commissionBps: s.commissionBps, commissionFixedCents: s.commissionFixedCents, upfrontFeeCents: 0, upfrontFeeStatus: "not_required", model2Disclosure: "off" }
  : { model: s.model, commissionType: "fixed", commissionBps: 0, commissionFixedCents: 0, upfrontFeeCents: s.upfrontFeeCents, upfrontFeeStatus: s.upfrontFeeCents > 0 ? "unpaid" : "not_required", model2Disclosure: s.model2Disclosure };

const int = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/** Commission up to 20%; fixed amounts and the upfront fee up to $1,000,000. */
export function validatePostingSettings(raw: unknown): { ok: true; value: PostingSettings } | { ok: false; error: string } {
  const b = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b) return { ok: false, error: "Send the settings as a JSON object." };
  const extra = Object.keys(b).filter(k => !(Object.keys(DEFAULT_POSTING) as string[]).includes(k));
  if (extra.length) return { ok: false, error: "Unknown setting." };
  if (!POSTING_MODELS.includes(b["model"] as PostingModel)) return { ok: false, error: "Choose model 1 or model 2." };
  if (b["commissionType"] !== "percent" && b["commissionType"] !== "fixed") return { ok: false, error: "Choose a percentage or a fixed commission." };
  if (!int(b["commissionBps"], 0, 2000)) return { ok: false, error: "Commission percentage must be between 0% and 20% (0 to 2000 basis points)." };
  if (!int(b["commissionFixedCents"], 0, 100_000_000)) return { ok: false, error: "Fixed commission must be between $0 and $1,000,000." };
  if (!int(b["upfrontFeeCents"], 0, 100_000_000)) return { ok: false, error: "Upfront fee must be between $0 and $1,000,000." };
  if (!MODEL2_DISCLOSURE.includes(b["model2Disclosure"] as Model2Disclosure)) return { ok: false, error: "Choose when model 2 contact details may be shown." };
  return { ok: true, value: b as unknown as PostingSettings };
}

const aud = (c: number) => `$${(c / 100).toLocaleString("en-AU", { minimumFractionDigits: c % 100 ? 2 : 0 })}`;
export const commissionText = (t: Pick<PostingTerms, "commissionType" | "commissionBps" | "commissionFixedCents">) =>
  t.commissionType === "percent" ? `${(t.commissionBps / 100).toFixed(2).replace(/\.?0+$/, "")}% of the amount in the signed contract` : `a fixed ${aud(t.commissionFixedCents)}`;

/** Plain-words explanation of each model, for the admin page. */
export const MODEL_EXPLAINERS: Record<PostingModel, { name: string; how: string; details: string; whoSees: string }> = {
  commission_on_contract: {
    name: "Model 1: Free posting, commission on first investment",
    how: "Posting is free. Nothing is paid now. When an investor and the poster agree and send the signed contract back through us, staff check it and our commission becomes due.",
    details: "The commission (a percentage or a fixed amount) is fixed on the project when it is posted. We send the poster a fee notice; staff mark it paid or waived by hand. We never take the fee out of investment money and never receive investor money.",
    whoSees: "Neither side sees the other's name, email or phone. They talk only in the platform chat; email notices come from the platform address with a link back to the chat. Emails, phone numbers and web links typed in messages are hidden."
  },
  upfront_fee: {
    name: "Model 2: Upfront fee, full disclosure",
    how: "The poster pays a posting fee before contact details can be shared. Payment goes through our payment provider (not connected yet, so it cannot be paid today).",
    details: "No commission. After the fee is paid, contact details are shown according to the disclosure setting below: never, straight after the fee, or only after the signed contract is returned.",
    whoSees: "Until disclosure unlocks, the same hiding as Model 1 applies. After it unlocks, investors in that conversation see the poster's name and email, and the poster sees theirs."
  }
};

/** The text a poster sees before submitting, for the admin preview and the posting form. */
export function posterText(s: PostingSettings): string {
  if (s.model === "commission_on_contract") {
    return `Posting is free. If an investor and you sign a contract and return it through us, our commission of ${commissionText(s)} becomes due and we will send you a fee notice. ` +
      "You pay it to us directly; it is never taken from investor money. Contact details stay hidden: all messages go through the platform.";
  }
  return `Posting needs an upfront fee of ${aud(s.upfrontFeeCents)}, paid to us before contact details can be shared. ` +
    (s.model2Disclosure === "off" ? "Contact details stay hidden; all messages go through the platform."
      : s.model2Disclosure === "after_fee" ? "After the fee is paid, investors in a conversation with you can see your name and email."
        : "After the fee is paid and a signed contract is returned through us, the other party's name and email are shown.");
}

// ---- Contact masking ----

const TLD = "(?:com|net|org|au|io|co|biz|info|me|app|xyz|online|site|email|uk|nz|us|dev|ai|ly|gg|link|page|store|shop|tech|cc|tv|to|in|ws|club|live|pro|top)";
const AT = String.raw`(?:\s*(?:@|[(\[{]\s*(?:at|@)\s*[)\]}])\s*)`;
const DOT = String.raw`(?:\s*(?:\.|[(\[{]\s*(?:dot|\.)\s*[)\]}])\s*|\s+dot\s+)`;
const EMAIL = new RegExp(String.raw`[\p{L}\p{N}._%+-]+${AT}[\p{L}\p{N}-]+(?:${DOT}[\p{L}\p{N}-]+)*`, "giu");
/** "jo at example dot com" / "jo at example.com": the spelled-out form, only when it ends in a known domain ending. */
const EMAIL_WORDS = new RegExp(String.raw`[\p{L}\p{N}._%+-]+\s+at\s+[\p{L}\p{N}-]+(?:${DOT}[\p{L}\p{N}-]+)*${DOT}${TLD}(?![\p{L}\p{N}])`, "giu");
const URL = new RegExp(String.raw`\b(?:https?:\/\/|www\.)[^\s<>"'()\[\]]+|\b[\p{L}\p{N}-]+(?:${DOT}[\p{L}\p{N}-]+)*${DOT}${TLD}(?![\p{L}\p{N}])(?:\/[^\s<>"'()\[\]]*)?`, "giu");
/** 8+ digits with any common separator; letters O/I/l standing in for digits and digits spelled as words count too. */
const DIGIT = "(?:[0-9]|[OoIl](?![\\p{L}])|(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?![\\p{L}]))";
const PHONE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:\+\s*)?${DIGIT}(?:[\s().\-/_~*|·•]*${DIGIT}){7,}`, "giu");
const REAL_DIGITS = /[0-9]|zero|oh|one|two|three|four|five|six|seven|eight|nine/gi;
export const MASK = "[hidden]";

/** Latin look-alikes (Cyrillic and Greek). Applied only inside a word that already mixes Latin with other letters. */
const CONFUSABLE: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ӏ": "l", "ո": "n", "ɡ": "g",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X"
};

/**
 * Undoes the usual tricks before matching: full-width and other compatibility forms (NFKC), invisible format characters
 * (zero-width, bidi, soft hyphen, emoji variation and keycap marks), and look-alike letters inside mixed-script words.
 */
export function normaliseForMasking(text: string): string {
  return text.normalize("NFKC")
    .replace(/[\p{Cf}͏ᅟᅠㅤ︀-️⃣]/gu, "")
    .replace(/[\p{L}\p{N}@._%+-]+/gu, w => (/[A-Za-z]/.test(w) && /[^\x00-\x7f]/.test(w) ? w.replace(/[^\x00-\x7f]/g, c => CONFUSABLE[c] ?? c) : w));
}

/**
 * Hides emails, web links and phone numbers (8+ digits), including spaced, spelled-out, full-width, zero-width and look-alike forms.
 * The text that comes back is the normalised text. `masked` tells the sender something was hidden.
 * `phones: false` keeps digit runs (for licence, ABN and ACN numbers in the issuer details).
 */
export function maskContacts(text: string, opts: { phones?: boolean } = {}): { text: string; masked: boolean } {
  let masked = false;
  const hide = () => { masked = true; return MASK; };
  let out = normaliseForMasking(text).replace(EMAIL, hide).replace(EMAIL_WORDS, hide).replace(URL, hide);
  if (opts.phones !== false) out = out.replace(PHONE, m => ((m.match(REAL_DIGITS)?.length ?? 0) >= 6 ? hide() : m));
  return { text: out, masked };
}
export const MASKED_NOTICE = "Contact details (emails, phone numbers and links) are not allowed here and were hidden. Keep talking through the platform.";

// ---- Signed contract ----

export type ContractStatus = "none" | "submitted" | "returned" | "rejected";

/** The investor uploads the signed contract; staff confirm or send it back. "returned" is final. */
export function contractTransition(from: ContractStatus, action: "submit" | "confirm" | "reject"): ContractStatus | null {
  if (action === "submit") return from === "none" || from === "rejected" ? "submitted" : null;
  if (from !== "submitted") return null;
  return action === "confirm" ? "returned" : "rejected";
}

/** Model 2 contact disclosure: fee paid and the rule recorded on the project (`setting`, from its terms) allows it at this stage. Model 1: never. */
export function contactsDisclosed(t: PostingTerms, setting: Model2Disclosure, contract: ContractStatus): boolean {
  if (t.model !== "upfront_fee" || t.upfrontFeeStatus !== "paid") return false;
  return setting === "after_fee" || (setting === "after_contract" && contract === "returned");
}

// ---- Platform fee (Model 1) ----

export type FeeStatus = "due" | "paid" | "waived";

export function feeAmount(t: PostingTerms, contractAmountCents: number): number {
  return t.commissionType === "percent" ? Math.round((contractAmountCents * t.commissionBps) / 10_000) : t.commissionFixedCents;
}

/** Staff mark a due fee paid (money received from the poster outside the platform's custody) or waived. Both are final. */
export function feeTransition(actor: StaffActor, from: FeeStatus, to: unknown, reason: unknown): { ok: true; to: FeeStatus } | { ok: false; status: 400 | 403 | 409; error: string } {
  if (!staffCan(actor, "investment.manage")) return { ok: false, status: 403, error: "Not allowed." };
  if (to !== "paid" && to !== "waived") return { ok: false, status: 400, error: "Mark the fee paid or waived." };
  if (typeof reason !== "string" || reason.trim().length < 10) return { ok: false, status: 400, error: "A reason of at least 10 characters is required." };
  if (from !== "due") return { ok: false, status: 409, error: "This fee is already settled." };
  return { ok: true, to };
}
