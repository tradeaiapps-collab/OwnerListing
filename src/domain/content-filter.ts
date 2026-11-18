import { findProfanity } from "./profanity-filter";

/**
 * Content filter for what people write to each other (messages) and what they publish about themselves (profiles).
 * Pure, rules only. It decides one of three things: allow, flag (the text goes through and staff see it later) or
 * block (the text is refused and never stored, so the permanent-record rule for messages still holds).
 * - contact_details: email, phone, links, social handles and chat apps. Blocked, so the conversation and its record stay
 *   on the platform. Links to the platform's own hosts are allowed.
 * - abuse: swearing, slurs and threats (the shared profanity filter). Mild words only flag; anything else blocks.
 * - spam: promotional and get-rich wording, shouting and repeated words. Flagged.
 * The lists are a starting map for staff and counsel to extend.
 */

export type ContentSource = "message" | "profile";
export type ContentCategory = "contact_details" | "abuse" | "spam";
export type ContentAction = "allow" | "flag" | "block";
export interface ContentHit { category: ContentCategory; action: "flag" | "block"; match: string }
export interface ContentScan { action: ContentAction; hits: ContentHit[] }

export const CONTENT_RULES_VERSION = "content-filter@1";

/** Words that only flag. They are rude, not abusive. */
const MILD = new Set(["crap", "damn", "goddamn", "bs", "bullshit", "piss", "pissed", "pos", "lmfao", "ass", "arse", "boob", "boobs", "tits", "wtf"]);

const EMAIL = /[a-z0-9._%+-]+\s*(?:@|\(at\)|\[at\]|\sat\s)\s*[a-z0-9-]+\s*(?:\.|\(dot\)|\[dot\]|\sdot\s)\s*[a-z]{2,}/i;
const PHONE = /(?<![\d$.,])(?:\+\s?61[\s.-]?\(?0?|\(?0)[2-478]\)?(?:[\s.-]?\d){8}(?!\d)/;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|au|me|ly|link|app|xyz|info|biz|ru|cn)(?:\/\S*)?\b/gi;
const HANDLE = /(?<![\w.])@[a-z0-9_.]{3,30}\b|\b(?:insta(?:gram)?|ig|snap(?:chat)?|tiktok|facebook|fb|telegram|wechat|whats\s?app|signal|viber|kik|line)\s*(?:id|handle|name|:|-)\s*@?[a-z0-9_.]{3,}\b|\b(?:whats\s?app|telegram|wechat|viber|snapchat|signal\s+app)\b|\b(?:dm|pm)\s+me\b/i;
const DIGIT_WORDS = /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[\s,-]+){8,}(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i;

const SPAM_PHRASES = /\b(?:click\s+here|limited\s+(?:time\s+)?offer|make\s+money\s+(?:fast|online|from\s+home)|work\s+from\s+home|guaranteed\s+(?:income|profit|returns?)|earn\s+\$?\d+\s*(?:k|a\s+day|per\s+day|daily)|crypto\s+(?:invest\w*|signals?)|forex|binary\s+options?|casino|online\s+betting|viagra|cialis|buy\s+followers|seo\s+services?|cheap\s+loans?|loan\s+offer|free\s+gift|you\s+(?:have\s+)?won|act\s+now|100%\s+(?:free|guaranteed)|no\s+obligation\s+call)\b/i;

function hostOf(raw: string): string {
  const h = raw.replace(/^https?:\/\//i, "").split(/[/?#:\s]/)[0] ?? "";
  return h.replace(/^www\./i, "").toLowerCase().replace(/[.,;!)]+$/, "");
}

/** Allowed hosts, e.g. the platform's own address. A host matches itself and its subdomains. */
const allowedHost = (host: string, allowed: readonly string[]) => allowed.some(a => host === a || host.endsWith(`.${a}`));

function contactHits(text: string, allowedHosts: readonly string[]): string[] {
  const out: string[] = [];
  const e = text.match(EMAIL); if (e) out.push(e[0].trim());
  const p = text.match(PHONE); if (p) out.push(p[0].trim());
  if (DIGIT_WORDS.test(text)) out.push("phone number in words");
  for (const u of text.match(URL_RE) ?? []) {
    // The domain part of an email is already reported above.
    if (e && e[0].toLowerCase().includes(u.toLowerCase())) continue;
    if (!allowedHost(hostOf(u), allowedHosts)) out.push(u);
  }
  const h = text.replace(EMAIL, " ").match(HANDLE); if (h) out.push(h[0].trim());
  return [...new Set(out)];
}

function spamHits(text: string): string[] {
  const out: string[] = [];
  const phrase = text.match(SPAM_PHRASES); if (phrase) out.push(phrase[0].toLowerCase());
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 30 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7) out.push("all capitals");
  const words = text.toLowerCase().match(/[a-z']{3,}/g) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, n] of counts) if (n >= 8 && n / words.length > 0.4) { out.push(`"${w}" repeated`); break; }
  if (/(.)\1{14,}/.test(text) || /[!?$]{6,}/.test(text)) out.push("repeated characters");
  return out;
}

export function scanContent(text: string, opts: { allowedHosts?: readonly string[] } = {}): ContentScan {
  const hits: ContentHit[] = [];
  if (!text || !text.trim()) return { action: "allow", hits };
  const t = text.normalize("NFKC").replace(/[\p{Cf}]/gu, "");
  const allowed = (opts.allowedHosts ?? []).map(h => h.toLowerCase());
  for (const m of contactHits(t, allowed)) hits.push({ category: "contact_details", action: "block", match: m });
  for (const m of findProfanity(t)) hits.push({ category: "abuse", action: MILD.has(m) ? "flag" : "block", match: m });
  for (const m of spamHits(t)) hits.push({ category: "spam", action: "flag", match: m });
  const action: ContentAction = hits.some(h => h.action === "block") ? "block" : hits.length ? "flag" : "allow";
  return { action, hits };
}

/** Scans several fields; the strongest action wins. Hits keep their field name so a person knows what to fix. */
export function scanFields(fields: Readonly<Record<string, string>>, opts: { allowedHosts?: readonly string[] } = {}): ContentScan & { byField: Record<string, ContentScan> } {
  const byField: Record<string, ContentScan> = {};
  const hits: ContentHit[] = [];
  for (const [k, v] of Object.entries(fields)) { const s = scanContent(v, opts); byField[k] = s; hits.push(...s.hits); }
  const action: ContentAction = hits.some(h => h.action === "block") ? "block" : hits.length ? "flag" : "allow";
  return { action, hits, byField };
}

/** What the person sees when their text is refused. It says what to change, never quotes it back. */
export function blockMessage(scan: ContentScan, source: ContentSource): string {
  const cats = new Set(scan.hits.filter(h => h.action === "block").map(h => h.category));
  const what = source === "message" ? "This message can't be sent" : "This can't be saved";
  if (cats.has("abuse")) return `${what}: it contains abusive or inappropriate language. Please rewrite it and try again.`;
  if (source === "message") return `${what}: it contains contact details or an outside link. Keep the conversation on the platform. Buyers and owners are put in touch through it once an offer is accepted.`;
  return `${what}: it contains contact details or an outside link. Your contact options are shown to buyers for you.`;
}

/** One row for staff: a piece of text that was refused or let through with a flag. Shared with the staff moderation queue. */
export interface ContentFlagInput {
  source: ContentSource;
  /** What the text belongs to, e.g. "enquiry_message", "agent_profile". */
  subjectType: string;
  /** The stored row's id, when the text was stored (flagged). Absent when it was refused (blocked). */
  subjectId?: string;
  field: string;
  userId: string;
  action: "flag" | "block";
  hits: readonly ContentHit[];
  /** The text, cut to 500 characters. Kept for refused text because nothing else stores it. */
  excerpt: string;
}

/** The small interface the moderation queue reads and the filter writes. */
export interface ContentFlagStore { record(flag: ContentFlagInput): Promise<void> }
