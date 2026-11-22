import { AU_JURISDICTIONS, isJurisdiction, type Jurisdiction } from "./jurisdiction";
import { cleanText, isCents, type ProjectStage } from "./investor-projects";

/**
 * Elena's investor onboarding and matching. Pure rules, no AI call: every reason shown to an investor comes straight from a field
 * of the project, so nothing is invented. Matching only: no advice, no ranking by expected return, nothing is committed or reserved.
 */

export const MATCH_NOTICE =
  "Elena matches projects to the preferences you give her. This is not financial, legal or tax advice and not a recommendation to invest. "
  + "Projects can lose money. Read each project's own risks and documents, and speak to a licensed adviser before you decide anything.";

export const RISK_LEVELS = ["cautious", "balanced", "growth"] as const;
export const TIMEFRAMES = ["under_2y", "2_4y", "4_plus", "flexible"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface InvestorPrefs {
  budgetMaxCents?: number; risk?: RiskLevel;
  /** undefined = not asked yet, [] = anywhere in Australia. */
  jurisdictions?: Jurisdiction[]; suburbs: string[]; timeframe?: Timeframe;
}
export const emptyPrefs = (): InvestorPrefs => ({ suburbs: [] });

export const STEPS = ["budget", "risk", "location", "timeframe"] as const;
export type Step = (typeof STEPS)[number];

export const RISK_LABEL: Record<RiskLevel, string> = {
  cautious: "Cautious: projects already approved or being built",
  balanced: "Balanced: some planning-stage projects are fine",
  growth: "Growth: earlier-stage projects are fine, I accept more risk"
};
export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  under_2y: "Under 2 years", "2_4y": "2 to 4 years", "4_plus": "4 years or more", flexible: "I'm flexible"
};

export interface Prompt {
  step: Step; text: string; kind: "amount" | "choice" | "location";
  options?: { value: string; label: string }[]; hint?: string;
}

export const nextStep = (p: InvestorPrefs): Step | null => {
  if (p.budgetMaxCents === undefined) return "budget";
  if (p.risk === undefined) return "risk";
  if (p.jurisdictions === undefined) return "location";
  if (p.timeframe === undefined) return "timeframe";
  return null;
};

/** Elena's wording for each step. Fixed text from our code. */
export function promptFor(step: Step): Prompt {
  switch (step) {
    case "budget": return { step, kind: "amount", text: "Hi, I'm Elena. I can match you with projects that suit you. First, what's the most you'd consider putting into a single project?", hint: "An approximate dollar amount is fine. It only filters projects by their minimum. Nothing is committed." };
    case "risk": return { step, kind: "choice", text: "How much risk are you comfortable with?", options: RISK_LEVELS.map(v => ({ value: v, label: RISK_LABEL[v] })), hint: "I use the project's stage as a guide. Every project can lose money." };
    case "location": return { step, kind: "location", text: "Where would you like to invest?", hint: "Pick states or territories, or anywhere. You can add up to 5 suburbs too (optional)." };
    case "timeframe": return { step, kind: "choice", text: "And how long could your money stay in a project?", options: TIMEFRAMES.map(v => ({ value: v, label: TIMEFRAME_LABEL[v] })) };
  }
}

/** Applies one answer. Unknown fields are refused. Returns the updated preferences. */
export function applyAnswer(prefs: InvestorPrefs, raw: unknown): { ok: true; step: Step; value: InvestorPrefs } | { ok: false; error: string } {
  const b = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b || typeof b["step"] !== "string" || !(STEPS as readonly string[]).includes(b["step"])) return { ok: false, error: "Answer one of Elena's questions." };
  const step = b["step"] as Step;
  const v = b["value"] !== null && typeof b["value"] === "object" && !Array.isArray(b["value"]) ? (b["value"] as Record<string, unknown>) : null;
  if (Object.keys(b).some(k => k !== "step" && k !== "value") || !v) return { ok: false, error: "Send { step, value }." };
  const allowed: Record<Step, string[]> = { budget: ["budgetMaxCents"], risk: ["risk"], location: ["jurisdictions", "suburbs"], timeframe: ["timeframe"] };
  if (Object.keys(v).some(k => !allowed[step].includes(k))) return { ok: false, error: "Unknown field." };
  const out: InvestorPrefs = { ...prefs, suburbs: [...prefs.suburbs] };
  if (step === "budget") {
    if (!isCents(v["budgetMaxCents"])) return { ok: false, error: "Enter a whole dollar amount of at least $1." };
    out.budgetMaxCents = v["budgetMaxCents"];
  } else if (step === "risk") {
    if (typeof v["risk"] !== "string" || !(RISK_LEVELS as readonly string[]).includes(v["risk"])) return { ok: false, error: "Choose cautious, balanced or growth." };
    out.risk = v["risk"] as RiskLevel;
  } else if (step === "timeframe") {
    if (typeof v["timeframe"] !== "string" || !(TIMEFRAMES as readonly string[]).includes(v["timeframe"])) return { ok: false, error: "Choose a timeframe." };
    out.timeframe = v["timeframe"] as Timeframe;
  } else {
    const j = v["jurisdictions"];
    if (!Array.isArray(j) || j.length > AU_JURISDICTIONS.length || !j.every(x => typeof x === "string" && isJurisdiction(x))) return { ok: false, error: "Choose states or territories, or leave it empty for anywhere." };
    out.jurisdictions = [...new Set(j as Jurisdiction[])];
    const s = v["suburbs"] ?? [];
    if (!Array.isArray(s) || s.length > 5) return { ok: false, error: "Up to 5 suburbs." };
    const suburbs: string[] = [];
    for (const x of s) {
      const c = cleanText(x, 2, 40);
      if (!c.ok) return { ok: false, error: `Suburb: ${c.error}` };
      suburbs.push(c.value);
    }
    out.suburbs = [...new Set(suburbs)];
  }
  return { ok: true, step, value: out };
}

export const isComplete = (p: InvestorPrefs): boolean => nextStep(p) === null;

// ---- Matching ----

/** Stage-based guide only (1 lowest). It is not a measure of a project's actual risk. */
const STAGE_RISK: Record<ProjectStage, number> = { completed: 1, construction: 2, approved: 2, planning: 3, concept: 4 };
const RISK_CAP: Record<RiskLevel, number> = { cautious: 2, balanced: 3, growth: 4 };
/** Rough years a project at this stage still needs. A guide for matching, not a forecast. */
const STAGE_YEARS: Record<ProjectStage, number> = { completed: 1, construction: 2, approved: 3, planning: 4, concept: 6 };
const TIME_YEARS: Record<Timeframe, number> = { under_2y: 2, "2_4y": 4, "4_plus": 99, flexible: 99 };
const STAGE_WORDS: Record<ProjectStage, string> = { completed: "completed", construction: "under construction", approved: "plans approved", planning: "in planning", concept: "at concept stage" };

export interface MatchProject {
  id: string; title: string; location: string; jurisdiction: string; projectType: string; stage: ProjectStage;
  minimumTicketCents: number; timeline: string; risks: string;
}
export interface Match { projectId: string; score: number; reasons: string[]; cautions: string[]; ownerTimeline: string; ownerRisks: string }
export interface MatchResult { matches: Match[]; considered: number; excluded: { budget: number; risk: number; location: number } }

const aud = (c: number) => (c / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const excerpt = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`; };
export const MAX_MATCHES = 5;

/** Ranks the projects the investor may already see. Hard filters: minimum above budget, stage two steps above their risk setting, state not chosen. */
export function matchProjects(prefs: InvestorPrefs, projects: readonly MatchProject[]): MatchResult {
  const excluded = { budget: 0, risk: 0, location: 0 };
  const out: Match[] = [];
  if (!isComplete(prefs)) return { matches: [], considered: projects.length, excluded };
  const budget = prefs.budgetMaxCents!, cap = RISK_CAP[prefs.risk!], states = prefs.jurisdictions!, years = TIME_YEARS[prefs.timeframe!];
  for (const p of projects) {
    if (p.minimumTicketCents > budget) { excluded.budget++; continue; }
    const level = STAGE_RISK[p.stage];
    if (level - cap >= 2) { excluded.risk++; continue; }
    if (states.length > 0 && !(states as string[]).includes(p.jurisdiction)) { excluded.location++; continue; }
    const reasons: string[] = [], cautions: string[] = [];
    let score = 30;
    reasons.push(`Minimum ${aud(p.minimumTicketCents)} is within your budget of ${aud(budget)}.`);
    if (level <= cap) { score += 25; reasons.push(`It is ${STAGE_WORDS[p.stage]}, which fits your ${prefs.risk} setting. (A stage guide only; read the project's own risks.)`); }
    else { score += 8; cautions.push(`It is ${STAGE_WORDS[p.stage]}, which is earlier than a ${prefs.risk} setting usually looks for.`); }
    if (states.length > 0) { score += 30; reasons.push(`It is in ${p.jurisdiction}, one of the places you chose.`); } else { score += 10; reasons.push("You said anywhere in Australia."); }
    const sub = prefs.suburbs.find(s => p.location.toLowerCase().includes(s.toLowerCase()));
    if (sub) { score += 10; reasons.push(`It is in ${p.location}, which includes ${sub}.`); }
    if (STAGE_YEARS[p.stage] <= years) { score += prefs.timeframe === "flexible" ? 10 : 15; reasons.push(prefs.timeframe === "flexible" ? "You are flexible on timing." : `Projects ${STAGE_WORDS[p.stage]} usually finish within your ${TIMEFRAME_LABEL[prefs.timeframe!].toLowerCase()}.`); }
    else cautions.push(`Projects ${STAGE_WORDS[p.stage]} can take longer than your ${TIMEFRAME_LABEL[prefs.timeframe!].toLowerCase()}. Check the owner's timeline below.`);
    out.push({ projectId: p.id, score: Math.min(100, score), reasons, cautions, ownerTimeline: excerpt(p.timeline, 200), ownerRisks: excerpt(p.risks, 240) });
  }
  out.sort((a, b) => b.score - a.score || a.projectId.localeCompare(b.projectId));
  return { matches: out.slice(0, MAX_MATCHES), considered: projects.length, excluded };
}

/** One plain sentence saying what Elena heard. */
export function summarisePrefs(p: InvestorPrefs): string {
  if (!isComplete(p)) return "";
  const where = p.jurisdictions!.length === 0 ? "anywhere in Australia" : p.jurisdictions!.join(", ");
  const sub = p.suburbs.length > 0 ? ` (${p.suburbs.join(", ")})` : "";
  return `A minimum within ${aud(p.budgetMaxCents!)}, ${p.risk} risk setting, ${where}${sub}, ${TIMEFRAME_LABEL[p.timeframe!].toLowerCase()}.`;
}
