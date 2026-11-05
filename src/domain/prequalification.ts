/**
 * Buyer pre-approval letters: Elena's reading of the letter text, the confidence rules and the views buyers, sellers and staff see.
 * Pure functions, rule based and self-hosted (no external AI). Elena reads and summarises; staff verify; nobody here accepts an offer.
 * Wording is a reading aid, not credit or financial advice.
 */
export const PREQUAL_ENGINE = "prequal-2026-11-05";
export const PREQUAL_DISCLAIMER = "Elena's reading of a lender letter is a guide only. A pre-approval is not a guarantee of finance.";

export type PrequalStatus = "pending_review" | "verified" | "resubmit_requested" | "expired";
export type Confidence = "high" | "medium" | "low";

export type ConditionCode =
  | "valuation" | "insurance" | "satisfactory_contract" | "sale_of_property" | "income_verification" | "credit_check" | "guarantor"
  | "change_in_circumstances" | "lmi" | "genuine_savings";

/** `standard` conditions are routine and do not lower confidence; `onerous` ones can make the approval fall away. */
export const CONDITIONS: Record<ConditionCode, { label: string; level: "standard" | "other" | "onerous"; match: RegExp }> = {
  valuation: { label: "a satisfactory property valuation", level: "standard", match: /\bvaluation\b/i },
  insurance: { label: "building insurance", level: "standard", match: /\b(building|home|property)\s+insurance\b|\binsurance\s+(cover|policy)\b/i },
  satisfactory_contract: { label: "a satisfactory contract of sale", level: "standard", match: /\b(satisfactory|acceptable)\s+(contract|title)\b|\breview\s+of\s+(the\s+)?contract\b/i },
  sale_of_property: { label: "sale of an existing property", level: "onerous", match: /\bsale\s+of\s+(your\s+|the\s+|an\s+)?(existing|current)\b|\bsell\s+(your|the)\s+(existing|current)\b/i },
  income_verification: { label: "further income or employment checks", level: "other", match: /\b(verification|confirmation)\s+of\s+(your\s+)?(income|employment)\b|\bemployment\s+(verification|confirmation)\b|\bfurther\s+(income|employment)\b|\bpayslips?\b/i },
  credit_check: { label: "a satisfactory credit check", level: "other", match: /\bcredit\s+(check|report|history)\b|\bsatisfactory\s+credit\b/i },
  guarantor: { label: "a guarantor", level: "onerous", match: /\bguarantor\b/i },
  change_in_circumstances: { label: "no change in circumstances", level: "onerous", match: /\bchange\s+(in|of)\s+(your\s+)?(financial\s+)?circumstances\b/i },
  lmi: { label: "lenders mortgage insurance", level: "other", match: /\blenders?\s+mortgage\s+insurance\b|\blmi\b/i },
  genuine_savings: { label: "proof of genuine savings", level: "other", match: /\bgenuine\s+savings\b|\bproof\s+of\s+(deposit|savings)\b/i }
};
export const CONDITION_CODES = Object.keys(CONDITIONS) as ConditionCode[];
export const isConditionCode = (v: unknown): v is ConditionCode => typeof v === "string" && Object.prototype.hasOwnProperty.call(CONDITIONS, v);

const LENDERS: readonly [string, RegExp][] = [
  ["Commonwealth Bank", /commonwealth\s+bank|\bCBA\b|commbank/i], ["Westpac", /westpac/i], ["NAB", /\bNAB\b|national\s+australia\s+bank/i],
  ["ANZ", /\bANZ\b|australia\s+and\s+new\s+zealand\s+banking/i], ["Macquarie Bank", /macquarie/i], ["ING", /\bING\b/], ["Bendigo Bank", /bendigo/i],
  ["St.George", /st\.?\s?george/i], ["Bank of Melbourne", /bank\s+of\s+melbourne/i], ["BankSA", /\bbanksa\b/i], ["Suncorp", /suncorp/i],
  ["Bankwest", /bankwest/i], ["AMP Bank", /\bAMP\s+bank/i], ["Great Southern Bank", /great\s+southern\s+bank/i], ["Newcastle Permanent", /newcastle\s+permanent/i]
];

export interface Extracted {
  lender?: string;
  approvedCents?: number;
  ratePercent?: number;
  termYears?: number;
  issuedOn?: string;
  /** YYYY-MM-DD printed on the letter, or worked out from "valid for N days" and the issue date. */
  expiresOn?: string;
  conditions: ConditionCode[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n: number) => String(n).padStart(2, "0");
function isoDate(y: number, m: number, d: number): string | undefined {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : undefined;
}
/** First date after `anchor` in the text. Reads "5 March 2027", "5th Mar 2027" and "05/03/2027" (day first, as in Australia). */
function dateAfter(text: string, anchor: RegExp): string | undefined {
  const m = anchor.exec(text);
  if (!m) return undefined;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
  const named = /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(tail);
  if (named) {
    const mi = MONTHS.findIndex(x => x === named[2]!.toLowerCase() || (named[2]!.length === 3 && x.startsWith(named[2]!.toLowerCase())));
    if (mi >= 0) return isoDate(Number(named[3]), mi + 1, Number(named[1]));
  }
  const slash = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(tail);
  return slash ? isoDate(Number(slash[3]), Number(slash[2]), Number(slash[1])) : undefined;
}

const toCents = (digits: string, suffix: string | undefined): number | undefined => {
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const mult = !suffix ? 1 : /^k$/i.test(suffix) ? 1_000 : 1_000_000;
  const cents = Math.round(n * mult * 100);
  return cents >= 1_000_000 && cents <= 5_000_000_000 ? cents : undefined; // $10,000 to $50 million
};

/** The approved amount: the largest dollar figure that sits next to words such as "pre-approved", "approved amount" or "loan amount". */
function findAmount(text: string): number | undefined {
  const keyword = /pre-?\s?approv\w*|approved\s+(?:amount|loan|lending|for)|amount\s+approved|loan\s+amount|borrowing\s+(?:power|capacity)|(?:lend|borrow)\s+up\s+to|up\s+to/gi;
  let best: number | undefined;
  for (let k = keyword.exec(text); k; k = keyword.exec(text)) {
    const tail = text.slice(k.index, k.index + 90);
    const money = /\$\s?([\d,]+(?:\.\d{1,2})?)\s*(k|m|million)?\b/i.exec(tail);
    const c = money ? toCents(money[1]!, money[2]) : undefined;
    if (c !== undefined && (best === undefined || c > best)) best = c;
  }
  return best;
}

/** Reads the facts Elena can find in a pre-approval letter. Anything not found stays undefined; staff confirm every figure. */
export function extractPreapproval(raw: string): Extracted {
  const text = raw.replace(/\s+/g, " ").slice(0, 60_000);
  const out: Extracted = { conditions: [] };
  const lender = LENDERS.find(([, re]) => re.test(text));
  if (lender) out.lender = lender[0];
  const amount = findAmount(text);
  if (amount !== undefined) out.approvedCents = amount;

  const rate = /(?:interest\s+rate|rate|p\.a\.?)[^%]{0,60}?(\d{1,2}(?:\.\d{1,3})?)\s*%|(\d{1,2}(?:\.\d{1,3})?)\s*%\s*(?:p\.a\.?|per\s+annum)/i.exec(text);
  const r = rate ? Number(rate[1] ?? rate[2]) : NaN;
  if (Number.isFinite(r) && r >= 0.5 && r <= 25) out.ratePercent = r;

  const term = /(?:loan\s+term|term)[^0-9]{0,30}(\d{1,2})\s*(?:years?|yrs?)|(\d{1,2})\s*(?:years?|yrs?)\s+(?:loan\s+)?term/i.exec(text);
  const t = term ? Number(term[1] ?? term[2]) : NaN;
  if (Number.isInteger(t) && t >= 1 && t <= 40) out.termYears = t;

  const issued = dateAfter(text, /(?:date\s+of\s+issue|issued(?:\s+on)?|dated?)[:\s]+/i);
  if (issued) out.issuedOn = issued;
  let expires = dateAfter(text, /(?:valid\s+(?:until|till|to|through)|expires?(?:\s+on)?|expiry(?:\s+date)?|until)[:\s]+/i);
  if (!expires && issued) {
    const span = /valid\s+for\s+(?:a\s+period\s+of\s+)?(\d{1,3})\s*(days?|months?)/i.exec(text);
    if (span) {
      const d = new Date(`${issued}T00:00:00Z`);
      if (/^day/i.test(span[2]!)) d.setUTCDate(d.getUTCDate() + Number(span[1])); else d.setUTCMonth(d.getUTCMonth() + Number(span[1]));
      expires = d.toISOString().slice(0, 10);
    }
  }
  if (expires) out.expiresOn = expires;

  out.conditions = CONDITION_CODES.filter(c => CONDITIONS[c].match.test(text));
  return out;
}

export interface RedFlag { code: "no_amount" | "low_vs_price" | "onerous_conditions" | "many_conditions" | "short_expiry" | "expired" | "no_expiry" | "unreadable"; text: string }
export interface Assessment { confidence: Confidence; flags: RedFlag[]; summary: string }

const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
const worst = (...c: Confidence[]): Confidence => c.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "high" as Confidence);
const aud = (cents: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(cents / 100);
const DAY = 86_400_000;

export interface AssessInput {
  approvedCents?: number | undefined;
  conditions: readonly ConditionCode[];
  expiresAt?: string | undefined;
  lender?: string | undefined;
  now: string;
  /** Offer (or asking) price to compare with. Leave out for a general pre-approval. */
  priceCents?: number | undefined;
}

/**
 * Confidence rules (the worst of the three decides):
 * - amount against price: high at 100% or more, medium 90 to 99%, low below 90%; no price to compare means this part is skipped;
 * - conditions: high with none or only routine ones (valuation, insurance, satisfactory contract), medium with others, low with an onerous one or four or more;
 * - validity: high above 90 days left, medium 30 to 90, low under 30 or expired; no date found is medium.
 * A letter with no readable amount is low.
 */
export function assess(i: AssessInput): Assessment {
  const flags: RedFlag[] = [];
  const parts: Confidence[] = [];
  if (i.approvedCents === undefined) {
    flags.push({ code: "no_amount", text: "Elena could not find the approved amount in the letter." });
    parts.push("low");
  } else if (i.priceCents !== undefined && i.priceCents > 0) {
    const ratio = i.approvedCents / i.priceCents;
    parts.push(ratio >= 1 ? "high" : ratio >= 0.9 ? "medium" : "low");
    if (ratio < 0.9) flags.push({ code: "low_vs_price", text: `The approved amount is ${Math.round(ratio * 100)}% of the price (${aud(i.priceCents)}).` });
  }
  const levels = i.conditions.map(c => CONDITIONS[c].level);
  if (levels.includes("onerous")) {
    parts.push("low");
    flags.push({ code: "onerous_conditions", text: `Onerous condition: ${i.conditions.filter(c => CONDITIONS[c].level === "onerous").map(c => CONDITIONS[c].label).join(", ")}.` });
  } else if (i.conditions.length >= 4) {
    parts.push("low");
    flags.push({ code: "many_conditions", text: `${i.conditions.length} conditions are attached to the approval.` });
  } else parts.push(levels.every(l => l === "standard") ? "high" : "medium");

  let validity = "";
  if (!i.expiresAt) {
    parts.push("medium");
    flags.push({ code: "no_expiry", text: "No expiry date was found on the letter." });
  } else {
    const days = Math.floor((Date.parse(i.expiresAt) - Date.parse(i.now)) / DAY);
    if (days < 0) { parts.push("low"); flags.push({ code: "expired", text: "This pre-approval has expired." }); validity = "It has expired."; }
    else {
      parts.push(days > 90 ? "high" : days >= 30 ? "medium" : "low");
      if (days < 30) flags.push({ code: "short_expiry", text: `Valid for only ${days} more day${days === 1 ? "" : "s"}.` });
      validity = `Valid for ${days} more day${days === 1 ? "" : "s"}.`;
    }
  }
  const conds = i.conditions.length === 0 ? " with no conditions" : ` subject to ${i.conditions.map(c => CONDITIONS[c].label).join(", ")}`;
  const lead = i.approvedCents === undefined ? "Pre-approval letter received, amount not read" : `Pre-approved for ${aud(i.approvedCents)}${conds}`;
  const summary = `${lead}${i.lender ? ` (${i.lender})` : ""}. ${validity}`.trim();
  return { confidence: worst(...parts), flags, summary };
}

/** The status shown to people: a verified approval past its expiry date reads as expired (no job needed). */
export function effectiveStatus(status: PrequalStatus, expiresAt: string | null | undefined, now: string): PrequalStatus {
  return status === "verified" && expiresAt && Date.parse(expiresAt) <= Date.parse(now) ? "expired" : status;
}

export const STATUS_LABEL: Record<PrequalStatus, string> = {
  pending_review: "Pending review", verified: "Verified", resubmit_requested: "More information needed", expired: "Expired"
};
export const STATUS_MARK: Record<PrequalStatus, string> = { pending_review: "⚠", verified: "✓", resubmit_requested: "⚠", expired: "✗" };

/** What a seller sees next to an offer. Personal and bank details never reach this shape; unverified letters show status only. */
export interface SellerPrequalView {
  state: "verified" | "pending" | "expired" | "none";
  label: string;
  confidence?: Confidence;
  summary?: string;
  approvedCents?: number;
  conditions?: string[];
  expiresAt?: string;
  flags?: string[];
}
export interface PrequalRow {
  status: PrequalStatus; approvedCents: number | null; conditions: ConditionCode[]; expiresAt: string | null; lender?: string | undefined;
}

export function sellerView(row: PrequalRow | undefined, offerPriceCents: number, now: string): SellerPrequalView {
  if (!row) return { state: "none", label: "No pre-approval shared" };
  const st = effectiveStatus(row.status, row.expiresAt, now);
  if (st === "expired") return { state: "expired", label: `${STATUS_MARK.expired} ${STATUS_LABEL.expired}` };
  if (st !== "verified" || row.approvedCents === null || !row.expiresAt) return { state: "pending", label: `${STATUS_MARK.pending_review} ${STATUS_LABEL.pending_review}` };
  const a = assess({ approvedCents: row.approvedCents, conditions: row.conditions, expiresAt: row.expiresAt, lender: row.lender, now, priceCents: offerPriceCents });
  return {
    state: "verified", label: `${STATUS_MARK.verified} ${STATUS_LABEL.verified}`, confidence: a.confidence, summary: a.summary,
    approvedCents: row.approvedCents, conditions: row.conditions.map(c => CONDITIONS[c].label), expiresAt: row.expiresAt, flags: a.flags.map(f => f.text)
  };
}

/** Agent and staff dashboard: no pre-approval, or one far below the price, is unqualified. */
export function isUnqualified(state: SellerPrequalView["state"], approvedCents: number | undefined, priceCents: number): boolean {
  return state === "none" || state === "expired" || (approvedCents !== undefined && priceCents > 0 && approvedCents / priceCents < 0.9);
}

// ---- Input parsing (buyer upload and staff review) ----
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Dollars typed by a person ("450,000", "$450000.50") to cents. */
export function parseDollars(v: unknown): Parsed<number | undefined> {
  if (blank(v)) return { ok: true, value: undefined };
  const s = String(v).replace(/[$,\s]/g, "");
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return bad("Enter the approved amount in dollars, for example 450000.");
  const cents = Math.round(Number(s) * 100);
  return cents >= 1_000_000 && cents <= 5_000_000_000 ? { ok: true, value: cents } : bad("The approved amount must be between $10,000 and $50,000,000.");
}

export interface BuyerDetails { approvedCents?: number; ratePercent?: number; termYears?: number; conditions: ConditionCode[]; listingId?: string; shareWithSellers: boolean }

/** Optional fields on the buyer's upload form. Everything is optional: Elena reads the letter for what is left out. */
export function parseBuyerDetails(f: { amount?: unknown; rate?: unknown; term?: unknown; conditions?: unknown; listingId?: unknown; share?: unknown }): Parsed<BuyerDetails> {
  const out: BuyerDetails = { conditions: [], shareWithSellers: f.share === undefined || f.share === null ? true : String(f.share) !== "false" };
  const amount = parseDollars(f.amount);
  if (!amount.ok) return amount;
  if (amount.value !== undefined) out.approvedCents = amount.value;
  if (!blank(f.rate)) {
    const r = Number(String(f.rate).replace(/%/g, "").trim());
    if (!Number.isFinite(r) || r < 0.5 || r > 25) return bad("Interest rate must be between 0.5 and 25 percent.");
    out.ratePercent = Math.round(r * 1000) / 1000;
  }
  if (!blank(f.term)) {
    const t = Number(String(f.term).trim());
    if (!Number.isInteger(t) || t < 1 || t > 40) return bad("Loan term must be a whole number of years from 1 to 40.");
    out.termYears = t;
  }
  if (!blank(f.conditions)) {
    const list = Array.isArray(f.conditions) ? f.conditions : String(f.conditions).split(",").map(s => s.trim()).filter(Boolean);
    if (list.length > CONDITION_CODES.length || !list.every(isConditionCode)) return bad("Unknown condition.");
    out.conditions = [...new Set(list as ConditionCode[])];
  }
  if (!blank(f.listingId)) {
    const id = String(f.listingId).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return bad("Invalid listing.");
    out.listingId = id;
  }
  return { ok: true, value: out };
}

export interface ReviewInput { action: "verify" | "resubmit"; note?: string; approvedCents?: number; ratePercent?: number; termYears?: number; conditions: ConditionCode[]; expiresOn?: string }

/** Staff decision. Verify needs the confirmed amount and expiry date; asking for a resubmission needs a note the buyer will read. */
export function parseReview(body: Record<string, unknown> | null, today: string): Parsed<ReviewInput> {
  if (!body) return bad("Send a JSON object.");
  const action = body["action"];
  if (action !== "verify" && action !== "resubmit") return bad("Choose verify or resubmit.");
  const note = typeof body["note"] === "string" ? body["note"].trim() : "";
  if (note.length > 1000) return bad("The note can be up to 1000 characters.");
  if (action === "resubmit") return note ? { ok: true, value: { action, note, conditions: [] } } : bad("Tell the buyer what to send again.");
  const cents = typeof body["approvedCents"] === "number" ? body["approvedCents"] : NaN;
  if (!Number.isInteger(cents) || cents < 1_000_000 || cents > 5_000_000_000) return bad("Confirm the approved amount (between $10,000 and $50,000,000).");
  const exp = body["expiresOn"];
  if (typeof exp !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(exp) || isoDate(Number(exp.slice(0, 4)), Number(exp.slice(5, 7)), Number(exp.slice(8))) !== exp) return bad("Confirm the expiry date (YYYY-MM-DD).");
  if (exp <= today) return bad("The expiry date is in the past. Ask the buyer for a current letter.");
  if (exp > `${Number(today.slice(0, 4)) + 2}${today.slice(4)}`) return bad("The expiry date is more than two years away. Check it against the letter.");
  const out: ReviewInput = { action, conditions: [], approvedCents: cents, expiresOn: exp, ...(note ? { note } : {}) };
  const conds = body["conditions"];
  if (conds !== undefined) {
    if (!Array.isArray(conds) || conds.length > CONDITION_CODES.length || !conds.every(isConditionCode)) return bad("Unknown condition.");
    out.conditions = [...new Set(conds as ConditionCode[])];
  }
  if (body["ratePercent"] != null) {
    const r = body["ratePercent"];
    if (typeof r !== "number" || r < 0.5 || r > 25) return bad("Interest rate must be between 0.5 and 25 percent.");
    out.ratePercent = r;
  }
  if (body["termYears"] != null) {
    const t = body["termYears"];
    if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > 40) return bad("Loan term must be a whole number of years from 1 to 40.");
    out.termYears = t;
  }
  return { ok: true, value: out };
}
