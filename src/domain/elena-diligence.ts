import { keySentences, moneyToCents, splitSentences } from "./doc-analyst";
import { findAddressRanges } from "./doc-masking";
import { scanContent } from "./content-filter";
import { EXPECTED_DOCS, LIMITS, maskText, makesReturnClaim, projectPassages, safeTitle, ADDRESS_WITHHELD } from "./elena-projects";
import type { InvestmentProject } from "./investor-projects";
import type { ProjectDocKind } from "./project-documents";

/**
 * Elena's due-diligence summary of one investor project. Pure rules, fixed wording: the only text taken from the documents is quoted
 * sentences, read through the address masking, with contact details and return or guarantee claims dropped. She states no figure that is not
 * quoted, predicts no return and gives no advice. The developer reads the summary and approves it before any investor sees it.
 */
export const DILIGENCE_ENGINE_VERSION = 1;
export const DILIGENCE_NOTICE =
  "Written by Elena, an AI, from the documents the developer has shared. It is not financial advice, an offer or a recommendation, it has not been checked by the platform, and it can miss things or get things wrong. Read the documents yourself and speak to a licensed adviser before you invest.";
export const NOTE_MAX = 1000;

export interface DiligenceInputDoc {
  id: string; title: string; kind: ProjectDocKind; uploadedAt: string; terms: readonly string[];
  /** Text per page. Empty when nothing could be read (an image or scan with no text layer). */
  pages: readonly string[];
}
/** Investor-visible documents still waiting for staff to confirm the address masking. Elena has not read them. */
export interface DiligencePendingDoc { id: string; title: string; kind: ProjectDocKind }

export interface Cite { docId: string | null; title: string; page: number | null }
export interface DiligenceDoc { id: string; title: string; kind: ProjectDocKind; pagesRead: number; readable: boolean; points: string[] }
export type Severity = "high" | "medium" | "low";
export interface DiligenceFlag { id: string; severity: Severity; title: string; detail: string }
export interface DiligenceRisk { id: string; severity: Severity; title: string; quote?: string; cite: Cite }
export interface DiligenceMismatch { id: string; severity: Severity; title: string; detail: string; cites: Cite[] }
export interface DiligenceSummary {
  engineVersion: number; generatedAt: string; headline: string;
  documents: DiligenceDoc[]; missing: DiligenceFlag[]; risks: DiligenceRisk[]; inconsistencies: DiligenceMismatch[];
  /** Documents shared with investors that Elena could not read yet, with the reason in plain words. */
  notRead: DiligenceFlag[];
}

// ---- Safe text ------------------------------------------------------------------------------------------------------------------

const leaks = (t: string, terms: readonly string[] = []) => findAddressRanges(t, terms).length > 0;
const hasContact = (t: string) => scanContent(t).hits.some(h => h.category === "contact_details");
const clip = (s: string, max: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
/** A sentence Elena may quote to an investor. */
const quotable = (s: string, terms: readonly string[]) =>
  s.length <= 240 && !leaks(s, terms) && !hasContact(s) && !makesReturnClaim(s) && !s.includes(ADDRESS_WITHHELD) && !/^page \d+ of \d+/i.test(s) && !/demo data/i.test(s);

const KIND_WORD: Record<ProjectDocKind, string> = { plan: "Plans", approval: "Approval", feasibility: "Feasibility study", contract: "Contract", report: "Report", other: "Document" };
const KIND_MISSING: Record<ProjectDocKind, string> = { plan: "plans", approval: "an approval", feasibility: "a feasibility study", contract: "a contract", report: "a progress report", other: "other documents" };
const DAY = 86_400_000;

// ---- Risks ----------------------------------------------------------------------------------------------------------------------

interface RiskRule { id: string; severity: Severity; title: string; re: RegExp }
const RISK_RULES: readonly RiskRule[] = [
  { id: "approval", severity: "high", title: "Approval may not be in place", re: /\b(?:not\s+yet\s+approved|awaiting\s+(?:council\s+)?approval|approval\s+(?:is\s+)?pending|pending\s+(?:council\s+)?approval|(?:DA|development\s+application)\s+(?:has\s+)?(?:not|yet\s+to)|refused|refusal|appeal)\b/i },
  { id: "conditions", severity: "medium", title: "Conditions attached", re: /\b(?:subject\s+to|conditional\s+(?:on|upon)|conditions?\s+(?:precedent|of\s+approval))\b/i },
  { id: "site", severity: "medium", title: "Site or title issue mentioned", re: /\b(?:flood\w*|contaminat\w*|acid\s+sulf\w+|asbestos|heritage|easements?|encumbrances?|covenants?|caveats?|bushfire)\b/i },
  { id: "cost", severity: "medium", title: "Cost or funding pressure mentioned", re: /\b(?:cost\s+overruns?|shortfall|insufficient|unfunded|not\s+yet\s+(?:secured|confirmed|funded)|pre-?sales?\s+(?:target|requirement|condition)|variations?|escalation)\b/i },
  { id: "delay", severity: "medium", title: "Delay mentioned", re: /\b(?:delay\w*|behind\s+schedule|postponed|extension\s+of\s+time|late\s+completion)\b/i },
  { id: "expiry", severity: "low", title: "Something may expire or lapse", re: /\b(?:expire[sd]?|expiry|lapse[sd]?|lapsing)\b/i },
  { id: "legal", severity: "high", title: "Dispute or default mentioned", re: /\b(?:disputes?|litigation|default(?:ed)?|breach(?:es|ed)?|insolven\w+|administrator|receivership)\b/i }
];
const MAX_RISKS = 14, PER_DOC_RULE = 2;

function findRisks(docs: readonly DiligenceInputDoc[]): DiligenceRisk[] {
  const out: DiligenceRisk[] = [];
  const sevOrder = { high: 0, medium: 1, low: 2 } as const;
  for (const d of docs) {
    const title = safeTitle(d.title, d.kind, d.terms);
    const used = new Map<string, number>();
    let claimNoted = false;
    d.pages.forEach((page, i) => {
      for (const s of splitSentences(maskText(page, d.terms)).slice(0, 4000)) {
        if (makesReturnClaim(s)) {
          if (!claimNoted) {
            claimNoted = true;
            out.push({ id: `claim-${d.id}`, severity: "medium", title: "Contains return or performance claims. Elena does not repeat them; read them next to the risks.", cite: { docId: d.id, title, page: i + 1 } });
          }
          continue;
        }
        for (const r of RISK_RULES) {
          if (!r.re.test(s) || (used.get(r.id) ?? 0) >= PER_DOC_RULE) continue;
          used.set(r.id, (used.get(r.id) ?? 0) + 1);
          out.push({ id: `${r.id}-${d.id}-${i + 1}-${used.get(r.id)}`, severity: r.severity, title: r.title, ...(quotable(s, d.terms) ? { quote: clip(s, 240) } : {}), cite: { docId: d.id, title, page: i + 1 } });
        }
      }
    });
  }
  return out.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]).slice(0, MAX_RISKS);
}

// ---- Inconsistencies ------------------------------------------------------------------------------------------------------------

interface Fact { key: string; value: number; label: string; show: string; cite: Cite }
const MONEY_LABELS: readonly { key: string; label: string; re: RegExp }[] = [
  { key: "cost", label: "total project cost", re: /\b(?:total\s+(?:project\s+|development\s+)?cost|project\s+cost|development\s+cost)\b/i },
  { key: "raise", label: "funding target", re: /\b(?:funding\s+target|(?:total\s+|equity\s+|capital\s+)?raise)\b/i },
  { key: "price", label: "purchase price", re: /\b(?:(?:site\s+)?purchase\s+price|acquisition\s+(?:price|cost))\b/i },
  { key: "build", label: "construction cost", re: /\b(?:construction\s+(?:cost|budget)|build\s+cost)\b/i }
];
const MONEY_AFTER = /^[^.$]{0,40}?((?:\$|aud\s?)\s?[\d,]+(?:\.\d{1,2})?\s?(?:k|m|million|thousand)?)\b/i;
const COUNT_RE = /\b(\d{1,3})\s+(?:new\s+|luxury\s+|boutique\s+)?(townhouses?|apartments?|units?|dwellings?|villas?|homes?|lots?|storeys?|stories|levels?)\b/gi;
const countGroup = (noun: string) => (/^(?:lot)/i.test(noun) ? "lots" : /^(?:store|stor|level)/i.test(noun) ? "storeys" : "dwellings");
const aud = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

function factsIn(text: string, cite: Cite, terms: readonly string[], out: Fact[]) {
  for (const s of splitSentences(maskText(text, terms)).slice(0, 4000)) {
    if (makesReturnClaim(s)) continue;
    for (const l of MONEY_LABELS) {
      const m = l.re.exec(s);
      if (!m) continue;
      const mm = MONEY_AFTER.exec(s.slice(m.index + m[0].length));
      const cents = mm ? moneyToCents(mm[1]!) : undefined;
      if (cents !== undefined && cents > 0) out.push({ key: `money-${l.key}`, value: cents, label: l.label, show: aud(cents), cite });
    }
    for (const c of s.matchAll(COUNT_RE)) {
      const g = countGroup(c[2]!);
      out.push({ key: `count-${g}`, value: Number(c[1]), label: g === "lots" ? "number of lots" : g === "storeys" ? "number of storeys" : "number of dwellings", show: `${c[1]}`, cite });
    }
  }
}

const sameValue = (key: string, a: number, b: number) => (key.startsWith("money") ? Math.abs(a - b) <= Math.max(a, b) * 0.01 : a === b);
const citeKey = (c: Cite) => c.docId ?? "project-page";

function findInconsistencies(project: InvestmentProject, docs: readonly DiligenceInputDoc[]): DiligenceMismatch[] {
  const facts: Fact[] = [];
  for (const d of docs) {
    const title = safeTitle(d.title, d.kind, d.terms);
    d.pages.forEach((p, i) => factsIn(p, { docId: d.id, title, page: i + 1 }, d.terms, facts));
  }
  for (const p of projectPassages(project)) factsIn(p.text, { docId: null, title: p.title, page: null }, [], facts);
  const byKey = new Map<string, Fact[]>();
  for (const f of facts) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  const out: DiligenceMismatch[] = [];
  for (const [key, list] of byKey) {
    // One value per source; two sources that state different values is what is worth a look.
    const per = new Map<string, Fact>();
    for (const f of list) if (!per.has(citeKey(f.cite))) per.set(citeKey(f.cite), f);
    const distinct: Fact[] = [];
    for (const f of per.values()) if (!distinct.some(x => sameValue(key, x.value, f.value))) distinct.push(f);
    if (distinct.length < 2) continue;
    const shown = distinct.slice(0, 3);
    const what = shown[0]!.label;
    out.push({
      id: `inc-${key}`, severity: key.startsWith("money") ? "high" : "medium", title: `Different ${what} in different places`,
      detail: `${shown.map(f => `${f.show} in ${f.cite.title}${f.cite.page ? ` (page ${f.cite.page})` : ""}`).join(", but ")}. One of them may be out of date. Ask the developer which is current.`,
      cites: shown.map(f => f.cite)
    });
  }
  return out;
}

// ---- The summary ----------------------------------------------------------------------------------------------------------------

/** What Elena makes of the documents. Same inputs and clock always give the same summary. */
export function buildDiligence(project: InvestmentProject, docs: readonly DiligenceInputDoc[], pending: readonly DiligencePendingDoc[], allVisible: readonly { kind: ProjectDocKind; uploadedAt: string; title: string; id: string }[], now: string): DiligenceSummary {
  const documents: DiligenceDoc[] = docs.map(d => {
    const text = d.pages.join("\n");
    const readable = text.trim().length >= 40;
    const points = readable
      ? keySentences(maskText(text, d.terms), 10).filter(s => quotable(s, d.terms)).slice(0, 3).map(s => clip(s, 240))
      : [];
    return { id: d.id, title: safeTitle(d.title, d.kind, d.terms), kind: d.kind, pagesRead: readable ? d.pages.length : 0, readable, points };
  });

  const notRead: DiligenceFlag[] = [
    ...documents.filter(d => !d.readable).map<DiligenceFlag>(d => ({ id: `unread-${d.id}`, severity: "medium", title: `“${d.title}” could not be read`,
      detail: "It has no text Elena can read (for example a scan or an image). Nothing in it is covered by this summary, so read it yourself." })),
    ...pending.map<DiligenceFlag>(d => ({ id: `pending-${d.id}`, severity: "low", title: `“${safeTitle(d.title, d.kind)}” is waiting for review`,
      detail: "Staff are still checking it for private details. It is not covered by this summary yet." }))
  ];

  const missing: DiligenceFlag[] = [];
  for (const k of EXPECTED_DOCS[project.stage]) {
    if (!allVisible.some(d => d.kind === k)) missing.push({ id: `missing-${k}`, severity: k === "approval" ? "high" : "medium", title: `No ${KIND_MISSING[k].replace(/^an? /, "")} shared`,
      detail: `Projects at the ${project.stage} stage usually share ${KIND_MISSING[k]}. Ask the developer for it before relying on this project.` });
  }
  if (allVisible.length === 0) missing.unshift({ id: "missing-any", severity: "high", title: "No documents shared yet", detail: "The developer has not shared any documents with investors, so there is nothing to check the project page against." });
  for (const d of allVisible) {
    const age = Math.floor((Date.parse(now) - Date.parse(d.uploadedAt)) / DAY);
    if ((d.kind === "report" || d.kind === "feasibility") && age >= LIMITS.staleDocDays) {
      missing.push({ id: `stale-${d.id}`, severity: "medium", title: `“${safeTitle(d.title, d.kind)}” is ${age} days old`, detail: "Figures in it may be out of date. Ask for a current version." });
    }
  }

  const risks = findRisks(docs), inconsistencies = findInconsistencies(project, docs);
  const read = documents.filter(d => d.readable);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const headline = `Elena read ${plural(read.length, "document")} (${plural(read.reduce((n, d) => n + d.pagesRead, 0), "page")}) and found ${plural(risks.length, "point")} to check on risk, ${plural(missing.length, "missing or out-of-date item")} and ${plural(inconsistencies.length, "possible inconsistency")}${notRead.length ? `. ${plural(notRead.length, "document")} could not be covered` : ""}.`;
  return { engineVersion: DILIGENCE_ENGINE_VERSION, generatedAt: now, headline, documents, missing, risks, inconsistencies, notRead };
}

/** Every string an investor would read, so one pass can check them all. */
function strings(s: DiligenceSummary): string[] {
  return [s.headline, ...s.documents.flatMap(d => [d.title, ...d.points]), ...[...s.missing, ...s.notRead].flatMap(f => [f.title, f.detail]),
    ...s.risks.flatMap(r => [r.title, r.quote ?? "", r.cite.title]), ...s.inconsistencies.flatMap(i => [i.title, i.detail, ...i.cites.map(c => c.title)])];
}
/** True when anything in the summary looks like a street address or contact detail. Used before storing and again before an investor reads it. */
export const summaryLeaks = (s: DiligenceSummary): boolean => strings(s).some(t => t && (leaks(t) || hasContact(t)));

/** Investor copy: anything that would leak is removed (never shown with a gap marker), so stored text can never widen what an investor sees. */
export function scrubForInvestor(s: DiligenceSummary): DiligenceSummary {
  const ok = (t: string | undefined) => !t || (!leaks(t) && !hasContact(t));
  return {
    ...s,
    documents: s.documents.map(d => ({ ...d, title: ok(d.title) ? d.title : KIND_WORD[d.kind], points: d.points.filter(ok) })),
    missing: s.missing.filter(f => ok(f.title) && ok(f.detail)), notRead: s.notRead.filter(f => ok(f.title) && ok(f.detail)),
    risks: s.risks.filter(r => ok(r.title) && ok(r.cite.title)).map(({ quote, ...r }) => (ok(quote) && quote ? { ...r, quote } : r)),
    inconsistencies: s.inconsistencies.filter(i => ok(i.title) && ok(i.detail))
  };
}

export function validateNote(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const t = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n").trim() : "";
  if (t.length > NOTE_MAX) return { ok: false, error: `Keep the note to ${NOTE_MAX} characters.` };
  if (t === "") return { ok: true, value: "" };
  const scan = scanContent(t);
  if (scan.hits.some(h => h.category === "contact_details")) return { ok: false, error: "Leave contact details out. Investors reach you through the platform." };
  if (scan.action === "block") return { ok: false, error: "That wording is not allowed. Please rephrase." };
  if (leaks(t)) return { ok: false, error: "The note looks like it contains a street address. Investors do not see the exact address." };
  if (/\b(?:guarantee[ds]?|risk[\s-]?free|can'?t\s+lose|assured\s+return)\b/i.test(t)) return { ok: false, error: "The note cannot promise or guarantee returns." };
  return { ok: true, value: t };
}
