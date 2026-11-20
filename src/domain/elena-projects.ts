import { findAddressRanges } from "./doc-masking";
import { keySentences, splitSentences } from "./doc-analyst";
import { scanContent } from "./content-filter";
import type { InvestmentProject } from "./investor-projects";
import type { ProjectDocKind, ProjectDocRecord } from "./project-documents";

/**
 * Elena for investor projects. Pure rules; the service layer stores things and sends notices.
 * Never bends: she answers only by quoting text the owner published (documents whose address masking staff confirmed, and the project page),
 * states no figure that is not in a quote, predicts no return, gives no advice, takes no commitment, shows no address, and passes anything
 * she cannot answer from the sources to the project owner.
 */
export const NOT_ADVICE =
  "Elena is an AI assistant. She only quotes what the project owner has published. This is not financial advice, an offer or a recommendation, and nobody has checked it for you. Speak to a licensed adviser before you invest.";
export const ADDRESS_WITHHELD = "[address withheld]";

export const LIMITS = {
  question: [5, 500], replyBody: [2, 2000], updateTitle: [3, 120], updateBody: [20, 4000],
  maxPassages: 600, maxAnswerSources: 3, quoteChars: 320, maxDocs: 12,
  staleDocDays: 180, quietDays: 90, noUpdateDays: 60,
  askPerHour: 20, draftPerDay: 6, maxFollowersNotified: 500
} as const;

export type Outcome = "answered" | "escalated" | "declined";
export interface Passage { docId: string | null; title: string; page: number | null; text: string }
export interface Source { docId: string | null; title: string; page: number | null; quote: string }
export interface Answer { outcome: Outcome; text: string; sources: Source[]; reason?: string }

// ---- Masking and safe text ------------------------------------------------------------------------------------------------------

/** Hides anything address-like, plus the exact terms staff entered for this document. */
export function maskText(text: string, terms: readonly string[] = []): string {
  const ranges = findAddressRanges(text, terms);
  if (ranges.length === 0) return text;
  let out = "", at = 0;
  for (const r of ranges) { out += text.slice(at, r.start) + ADDRESS_WITHHELD; at = r.end; }
  return out + text.slice(at);
}
const leaksAddress = (text: string, terms: readonly string[]) => findAddressRanges(text, terms).length > 0;
const hasContact = (text: string) => scanContent(text).hits.some(h => h.category === "contact_details");

const clip = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Splits one page (or section) of already-masked text into short passages Elena can quote. */
export function toPassages(docId: string | null, title: string, page: number | null, text: string, terms: readonly string[] = []): Passage[] {
  const masked = maskText(text, terms);
  const sentences = splitSentences(masked);
  const out: Passage[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > LIMITS.quoteChars) { out.push({ docId, title, page, text: cur }); cur = ""; }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push({ docId, title, page, text: cur });
  return out.map(p => ({ ...p, text: clip(p.text, LIMITS.quoteChars) }));
}

const money = (c: number) => (c / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

/** The project page itself as quotable sections. `location` is suburb level only and is already shown to every investor. */
export function projectPassages(p: InvestmentProject): Passage[] {
  const sec = (name: string, text: string) => (text.trim() ? toPassages(null, `Project page: ${name}`, null, text) : []);
  return [
    { docId: null, title: "Project page: Key figures", page: null, text:
      `Indicative funding target ${money(p.fundingTargetCents)}. Indicative minimum ${money(p.minimumTicketCents)}. Stage: ${p.stage}. Location: ${p.location}, ${p.jurisdiction}. Issuer: ${p.issuerName}.` },
    ...sec("Summary", p.summary), ...sec("Timeline", p.timeline), ...sec("Risks", p.risks), ...sec("Structure", p.structureDescription),
    ...sec("Issuer declaration", `${p.issuerLicenceBasis}. ${p.issuerStatement}`)
  ];
}

// ---- Question handling ----------------------------------------------------------------------------------------------------------

export type QuestionKind = "ok" | "address" | "contact" | "advice" | "commit";
const ADDRESS_Q = /\b(?:exact|full|street|precise|actual)\s+(?:address|location)\b|\bwhat(?:'s|\s+is)\s+the\s+address\b|\bwhere\s+(?:exactly|precisely)\b|\blot\s*(?:number|\/\s*plan)\b|\b(?:gps|coordinates|lat(?:itude)?\s*\/?\s*long(?:itude)?)\b|\bwhich\s+street\b|\bdrop\s+(?:a\s+)?pin\b/i;
const CONTACT_Q = /\b(?:phone|mobile|email|e-mail|contact\s+(?:details|number|info\w*)|call\s+(?:him|her|them|the\s+owner)|whats\s?app|speak\s+(?:to|with)\s+the\s+owner)\b/i;
const ADVICE_Q = /\b(?:should\s+i|would\s+you\s+(?:recommend|invest|buy)|do\s+you\s+recommend|is\s+(?:it|this)\s+(?:a\s+)?(?:good|safe|sound|smart|worth)|worth\s+(?:investing|it)|will\s+i\s+(?:make|get|earn|lose|profit)|how\s+much\s+(?:will|can|could|would)\s+i\s+(?:make|earn|get|profit)|guarantee\w*|risk[\s-]?free|safe\s+investment|best\s+investment|sure\s+thing|can\s+i\s+lose|expected\s+(?:return|profit|yield)|projected\s+(?:return|profit|yield)|what\s+(?:return|yield|profit)\s+(?:will|can))\b/i;
const COMMIT_Q = /\b(?:reserve|secure|lock\s+in|put\s+me\s+down|sign\s+me\s+up|take\s+my\s+(?:money|deposit)|invest\s+(?:now|for\s+me)|buy\s+in\s+for\s+me|transfer|wire|pay(?:ment)?\s+(?:now|today)|send\s+(?:you|the)\s+(?:money|funds|deposit))\b/i;

export function classifyQuestion(q: string): QuestionKind {
  if (COMMIT_Q.test(q)) return "commit";
  if (ADVICE_Q.test(q)) return "advice";
  if (ADDRESS_Q.test(q)) return "address";
  if (CONTACT_Q.test(q)) return "contact";
  return "ok";
}

export function validateQuestion(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Type a question." };
  const t = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  const [lo, hi] = LIMITS.question;
  if (t.length < lo) return { ok: false, error: "Type a question." };
  if (t.length > hi) return { ok: false, error: `Questions can be up to ${hi} characters.` };
  const scan = scanContent(t);
  if (scan.hits.some(h => h.category === "contact_details")) return { ok: false, error: "Please leave contact details out. Use Express interest to start a conversation with the owner." };
  if (scan.action === "block") return { ok: false, error: "That wording is not allowed here. Please rephrase." };
  return { ok: true, value: t };
}

const STOP = new Set("a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its may me more most must my no not of on or our shall she should so such that the their them then there these they this to us was we were what when where which who will with would you your tell about please much many".split(" "));
const stem = (w: string) => {
  let x = w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
  if (x.length > 5 && x.endsWith("ing")) x = x.slice(0, -3);
  else if (x.length > 4 && x.endsWith("ed")) x = x.slice(0, -2);
  if (x.length > 4 && x.endsWith("e")) x = x.slice(0, -1);
  return x;
};
export const tokens = (s: string): string[] => (s.toLowerCase().match(/[a-z0-9$%][a-z0-9$%'-]*/g) ?? []).filter(w => !STOP.has(w) && w.length > 1).map(stem);

/** Passages that share words with the question, best first. A passage needs two shared words (one when the question has only one or two). */
export function retrieve(question: string, passages: readonly Passage[], max: number = LIMITS.maxAnswerSources): Passage[] {
  const q = [...new Set(tokens(question))];
  if (q.length === 0) return [];
  const need = q.length <= 2 ? 1 : 2;
  const numeric = /\b(?:how\s+(?:much|many|long)|cost|price|amount|percent|\d+|when|date|deadline|minimum|target)\b|[$%]/i.test(question);
  const df = new Map<string, number>();
  const pt = passages.map(p => new Set(tokens(`${p.title} ${p.text}`)));
  for (const set of pt) for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  const scored = passages.map((p, i) => {
    const hit = q.filter(w => pt[i]!.has(w));
    const score = hit.reduce((n, w) => n + Math.log(2 + passages.length / (df.get(w) ?? 1)), 0) + (numeric && /[$\d]/.test(p.text) ? 1 : 0);
    return { p, i, n: hit.length, score };
  }).filter(x => x.n >= need).sort((a, b) => b.score - a.score || a.i - b.i);
  const out: Passage[] = [], seen = new Set<string>();
  for (const x of scored) { if (!seen.has(x.p.text)) { seen.add(x.p.text); out.push(x.p); } if (out.length >= max) break; }
  return out;
}

const sourceLabel = (s: Source) => `${s.title}${s.page ? `, page ${s.page}` : ""}`;

/**
 * The reply to one question. Order: commitments and advice are declined; address and contact questions go to the owner; otherwise the
 * question is answered by quoting passages, and when nothing matches it goes to the owner. Quotes that would show an address or contact
 * details are dropped, never edited into a new sentence.
 */
export function answerQuestion(question: string, passages: readonly Passage[], terms: readonly string[] = []): Answer {
  const kind = classifyQuestion(question);
  if (kind === "commit") return { outcome: "declined", reason: "commitment", sources: [],
    text: "I can't reserve, secure or take anything on anyone's behalf, and nothing is paid on this platform. If you are interested, use Express interest to open a non-binding conversation with the project owner." };
  if (kind === "advice") return { outcome: "declined", reason: "advice_or_returns", sources: [],
    text: "I can't say whether this is a good investment, predict returns or promise any outcome. Every figure I can give is quoted from the documents. You can lose money in a project like this, so please speak to a licensed financial adviser." };
  if (kind === "address") return { outcome: "escalated", reason: "address_withheld", sources: [],
    text: "The exact address is not shown on the platform. I have passed your question to the project owner, who can decide what to share once you have started a conversation." };
  if (kind === "contact") return { outcome: "escalated", reason: "contact_request", sources: [],
    text: "I can't share anyone's contact details. I have passed your question to the project owner. You can also use Express interest to start a conversation on the platform." };
  const sources: Source[] = [];
  for (const p of retrieve(question, passages, LIMITS.maxAnswerSources + 3)) {
    if (leaksAddress(p.text, terms) || hasContact(p.text)) continue;
    sources.push({ docId: p.docId, title: p.title, page: p.page, quote: clip(p.text, LIMITS.quoteChars) });
    if (sources.length >= LIMITS.maxAnswerSources) break;
  }
  if (sources.length === 0) return { outcome: "escalated", reason: "not_in_documents", sources: [],
    text: "I couldn't find that in the documents and details the owner has published, and I won't guess. I have passed your question to the project owner." };
  return { outcome: "answered", sources,
    text: `Here is what the published material says:\n${sources.map(s => `• “${s.quote}” (${sourceLabel(s)})`).join("\n")}\nI have only quoted the documents. They are stated by the owner and not checked by the platform.` };
}

// ---- Keeping the project current ------------------------------------------------------------------------------------------------

/** What an investor reasonably expects to find by stage. Missing ones are suggested to the owner, never required. */
export const EXPECTED_DOCS: Record<InvestmentProject["stage"], readonly ProjectDocKind[]> = {
  concept: [], planning: ["plan", "feasibility"], approved: ["plan", "feasibility", "approval"], construction: ["plan", "approval", "report"], completed: ["report"]
};
const KIND_WORD: Record<ProjectDocKind, string> = { plan: "plans", approval: "approvals", feasibility: "a feasibility study", contract: "a contract", report: "a progress report", other: "other documents" };

export interface ReviewFlag { id: string; severity: "high" | "medium" | "low"; title: string; detail: string; action: string }
export interface ReviewDoc extends ProjectDocRecord { masking: "not_needed" | "pending" | "confirmed" }

const DAY = 86_400_000;
const days = (from: string, now: string) => Math.floor((Date.parse(now) - Date.parse(from)) / DAY);

/** Flags for the owner: documents missing for the stage, stale documents, documents investors cannot see yet, and a quiet project. `docs` are current versions. */
export function reviewProject(project: InvestmentProject, docs: readonly ReviewDoc[], lastUpdateAt: string | undefined, now: string): ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  const shown = docs.filter(d => d.visibility === "investors");
  const seen = (k: ProjectDocKind) => shown.some(d => d.kind === k);
  for (const k of EXPECTED_DOCS[project.stage]) {
    if (!seen(k)) flags.push({ id: `missing-${k}`, severity: "medium", title: `No ${k === "feasibility" ? "feasibility study" : k === "report" ? "progress report" : k} shared with investors`,
      detail: `Projects at the ${project.stage} stage usually share ${KIND_WORD[k]}. Investors asking about this will be sent to you.`, action: "Add the document and share it with investors." });
  }
  for (const d of shown) {
    const age = days(d.uploadedAt, now);
    if ((d.kind === "report" || d.kind === "feasibility") && age >= LIMITS.staleDocDays)
      flags.push({ id: `stale-${d.id}`, severity: "medium", title: `“${d.title}” is ${age} days old`, detail: "Investors may rely on figures that are out of date.", action: "Upload a current version, or add an update saying nothing has changed." });
    if (d.masking === "pending")
      flags.push({ id: `masking-${d.id}`, severity: "low", title: `“${d.title}” is waiting for address masking review`, detail: "Investors cannot read it, and Elena cannot quote it, until reviewers confirm the masking.", action: "No action needed; reviewers are checking it." });
  }
  const newest = shown.reduce<string | undefined>((m, d) => (m === undefined || d.uploadedAt > m ? d.uploadedAt : m), undefined);
  if (project.status === "approved" && project.stage !== "completed") {
    if (newest !== undefined && days(newest, now) >= LIMITS.quietDays)
      flags.push({ id: "quiet-docs", severity: "medium", title: `No new document for ${days(newest, now)} days`, detail: "A project that has moved on should show it in its documents.", action: "Upload what has changed." });
    const last = [lastUpdateAt, project.createdAt].filter((x): x is string => !!x).sort().pop()!;
    if (days(last, now) >= LIMITS.noUpdateDays)
      flags.push({ id: "no-update", severity: "low", title: `No update to investors for ${days(last, now)} days`, detail: "Followers hear nothing until you publish an update.", action: "Ask Elena to draft an update." });
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

export interface DraftDoc { id: string; title: string; kind: ProjectDocKind; uploadedAt: string; text: string; terms: readonly string[] }
export interface UpdateDraft { title: string; body: string; sourceDocIds: string[] }

const KIND_LABEL: Record<ProjectDocKind, string> = { plan: "plans", approval: "approval", feasibility: "feasibility study", contract: "contract", report: "report", other: "document" };
const dateWord = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Brisbane" });

/**
 * A draft update from newly added documents. Fixed wording; the only content from the documents is quoted sentences, with addresses hidden
 * and anything with contact details dropped. The owner must edit and approve before any investor sees it.
 */
export function draftUpdate(project: Pick<InvestmentProject, "title">, docs: readonly DraftDoc[], now: string): UpdateDraft | undefined {
  if (docs.length === 0) return undefined;
  const lines: string[] = [];
  for (const d of docs) {
    lines.push(`• New ${KIND_LABEL[d.kind]}: ${d.title} (added ${dateWord(d.uploadedAt)}).`);
    const picks = keySentences(maskText(d.text, d.terms), 6).filter(s => !leaksAddress(s, d.terms) && !hasContact(s)).slice(0, 2);
    for (const s of picks) lines.push(`   “${s}”`);
  }
  const body = clip2(`${project.title}: new documents are now available to investors.\n\n${lines.join("\n")}\n\nThe figures above are quoted from the documents. They are the project owner's statements, not checked by the platform, and not financial advice.`, LIMITS.updateBody[1]);
  return { title: `Update ${dateWord(now)}: ${docs.length === 1 ? "new document" : `${docs.length} new documents`}`, body, sourceDocIds: docs.map(d => d.id) };
}
const clip2 = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** An owner's edit of an update: length limits, no contact details or blocked words, no address-like text (investors read it). */
export function validateUpdate(raw: unknown): { ok: true; value: { title: string; body: string } } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Send a title and text." };
  const o = raw as Record<string, unknown>;
  const title = typeof o["title"] === "string" ? o["title"].replace(/\s+/g, " ").trim() : "";
  const body = typeof o["body"] === "string" ? o["body"].replace(/\r\n?/g, "\n").trim() : "";
  const [tl, th] = LIMITS.updateTitle, [bl, bh] = LIMITS.updateBody;
  if (title.length < tl || title.length > th) return { ok: false, error: `The title needs ${tl} to ${th} characters.` };
  if (body.length < bl || body.length > bh) return { ok: false, error: `The text needs ${bl} to ${bh} characters.` };
  const scan = scanContent(`${title}\n${body}`);
  if (scan.hits.some(h => h.category === "contact_details")) return { ok: false, error: "Updates cannot include contact details. Investors reach you through the platform." };
  if (scan.action === "block") return { ok: false, error: "That wording is not allowed. Please rephrase." };
  if (leaksAddress(`${title}\n${body}`, [])) return { ok: false, error: "The text looks like it contains a street address or lot number. Investors do not see the exact address." };
  if (/\b(?:guarantee[ds]?|risk[\s-]?free|can'?t\s+lose|assured\s+return)\b/i.test(`${title} ${body}`)) return { ok: false, error: "Updates cannot promise or guarantee returns." };
  return { ok: true, value: { title, body } };
}

export function validateReply(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const t = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  const [lo, hi] = LIMITS.replyBody;
  if (t.length < lo || t.length > hi) return { ok: false, error: `The reply needs ${lo} to ${hi} characters.` };
  const scan = scanContent(t);
  if (scan.hits.some(h => h.category === "contact_details")) return { ok: false, error: "Please leave contact details out; keep the conversation on the platform." };
  if (scan.action === "block") return { ok: false, error: "That wording is not allowed. Please rephrase." };
  if (leaksAddress(t, [])) return { ok: false, error: "The reply looks like it contains a street address. Share the exact address only after contract details are unlocked." };
  return { ok: true, value: t };
}
