/**
 * Elena's feasibility risk analyzer for project proposals. Pure rules, no model and no network. Scores complexity on a story point scale,
 * lists risks, estimates the chance of success and compares the proposal with the team's finished projects. It advises: it never assigns
 * people, forecasts budget or reads contracts. Bump ENGINE_VERSION when a rule or weight changes.
 */
export const ENGINE_VERSION = "feasibility-v1";
export const POINT_SCALE = [1, 2, 3, 5, 8, 13, 21] as const;
export type Points = (typeof POINT_SCALE)[number];
export const BASE_SUCCESS = 70;
export const MIN_HISTORY = 3;

export type Clarity = "clear" | "partial" | "unclear";
export type Severity = "low" | "medium" | "high";
export type RiskCategory = "technical" | "resource" | "budget" | "timeline" | "dependency";
export type Outcome = "succeeded" | "failed";

export interface ProposalInput {
  title: string;
  description: string;
  timelineWeeks: number;
  teamSize: number;
  systemsTouched: number;
  newTechnologies: string[];
  externalDependencies: string[];
  compliance: boolean;
  legalSignOff: boolean;
  requirements: Clarity;
  teamHasExpertise: "yes" | "no" | "unknown";
  budgetJustified: "yes" | "no" | "unknown";
}
export interface HistoryProject { name: string; points: number; weeks: number; outcome: Outcome }

export interface Risk { category: RiskCategory; severity: Severity; title: string; detail: string; impact: number }
export interface CheckItem { key: string; label: string; status: "yes" | "no" | "unknown"; note: string }
export interface Comparison {
  enough: boolean; projectsUsed: number; similarCount: number; similarWeeks: { min: number; max: number } | null; velocity: number | null;
  weeksAtVelocity: number | null; teamSuccessRate: number | null; messages: string[];
}
export interface Analysis {
  engine: string; points: Points; rawScore: number; band: "trivial" | "medium" | "complex"; successProbability: number;
  factors: string[]; risks: Risk[]; recommendations: string[]; checklist: CheckItem[]; comparison: Comparison; notes: string[];
}

const LIM = { title: 120, description: 4000, listItem: 80, listMax: 10 };
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): string[] | null => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > LIM.listMax) return null;
  const out: string[] = [];
  for (const x of v) { const s = str(x); if (!s || s.length > LIM.listItem) return null; out.push(s); }
  return out;
};
const oneOf = <T extends string>(v: unknown, set: readonly T[], dflt: T): T | null => (v === undefined ? dflt : typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null);
const whole = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null);

/** Checks a request body. Errors are written for staff to read. */
export function parseProposal(b: Record<string, unknown> | null): { ok: true; value: ProposalInput } | { ok: false; error: string } {
  const e = (error: string) => ({ ok: false as const, error });
  if (!b) return e("Send the proposal as JSON.");
  const title = str(b["title"]), description = str(b["description"]);
  if (!title || title.length > LIM.title) return e(`Give the proposal a title of up to ${LIM.title} characters.`);
  if (description.length < 20 || description.length > LIM.description) return e(`Describe the scope in 20 to ${LIM.description} characters.`);
  const timelineWeeks = whole(b["timelineWeeks"], 1, 104), teamSize = whole(b["teamSize"], 1, 100), systemsTouched = whole(b["systemsTouched"] ?? 1, 1, 50);
  if (timelineWeeks === null) return e("The timeline must be a whole number of weeks from 1 to 104.");
  if (teamSize === null) return e("The team size must be a whole number from 1 to 100.");
  if (systemsTouched === null) return e("Systems touched must be a whole number from 1 to 50.");
  const newTechnologies = list(b["newTechnologies"]), externalDependencies = list(b["externalDependencies"]);
  if (!newTechnologies || !externalDependencies) return e(`New technologies and external dependencies are lists of up to ${LIM.listMax} short items.`);
  const requirements = oneOf(b["requirements"], ["clear", "partial", "unclear"], "partial");
  const teamHasExpertise = oneOf(b["teamHasExpertise"], ["yes", "no", "unknown"], "unknown");
  const budgetJustified = oneOf(b["budgetJustified"], ["yes", "no", "unknown"], "unknown");
  if (!requirements || !teamHasExpertise || !budgetJustified) return e("Requirements must be clear, partial or unclear; the other two answers are yes, no or unknown.");
  for (const k of ["compliance", "legalSignOff"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return e(`${k} must be true or false.`);
  return { ok: true, value: { title, description, timelineWeeks, teamSize, systemsTouched, newTechnologies, externalDependencies, compliance: b["compliance"] === true, legalSignOff: b["legalSignOff"] === true, requirements, teamHasExpertise, budgetJustified } };
}

const COMPLIANCE_RE = /\b(legal|compliance|privacy|consent|trust account|aml|kyc|regulat\w*|licen[cs]e|counsel|gdpr|audit)\b/gi;
const INTEGRATION_RE = /\b(api|webhook|integrat\w*|third[- ]party|oauth|sso|payment|stripe|docusign|sync)\b/gi;
const VAGUE_RE = /\b(tbd|tbc|to be decided|not sure|unclear|maybe|somehow|etc|and more|nice to have|as needed)\b/gi;
const CREEP_RE = /\b(also|as well|in addition|and then|plus|while we.re at it|extra)\b/gi;
const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;
const ceilStep = (n: number): Points => POINT_SCALE.find(p => p >= n) ?? 21;
const bandOf = (p: number): Analysis["band"] => (p <= 5 ? "trivial" : p <= 13 ? "medium" : "complex");
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Story points from scope size, systems, new technology, dependencies, compliance and a tight timeline. */
export function scoreComplexity(p: ProposalInput): { points: Points; raw: number; factors: string[] } {
  const factors: string[] = [];
  const add = (n: number, why: string) => { if (n > 0) { raw += n; factors.push(`+${n} ${why}`); } };
  let raw = 1;
  const words = p.description.split(/\s+/).length;
  add(words > 250 ? 3 : words > 120 ? 2 : words > 50 ? 1 : 0, `scope described in ${words} words`);
  add(Math.min(6, (p.systemsTouched - 1) * 2), `${p.systemsTouched} systems touched`);
  add(Math.min(6, p.newTechnologies.length * 2), `new technology: ${p.newTechnologies.join(", ")}`);
  add(Math.min(6, p.externalDependencies.length * 2), `${p.externalDependencies.length} external dependencies`);
  add(Math.min(3, Math.max(0, count(INTEGRATION_RE, p.description) - p.externalDependencies.length)), "integration work mentioned in the scope");
  add(p.compliance || count(COMPLIANCE_RE, p.description) >= 2 ? 3 : 0, "compliance or legal work");
  const tight = tightness(p);
  add(tight >= 1.5 ? 3 : tight >= 1 ? 2 : 0, "tight timeline for this much work");
  return { points: ceilStep(raw), raw, factors };
}

/** Rough weeks the scope needs for the team size, relative to the weeks given. Above 1 means the timeline looks short. */
function tightness(p: ProposalInput): number {
  const words = p.description.split(/\s+/).length;
  const need = (1 + Math.min(6, (p.systemsTouched - 1) * 2) + Math.min(6, p.newTechnologies.length * 2) + Math.min(6, p.externalDependencies.length * 2) + (words > 120 ? 2 : 0)) / Math.max(1, Math.sqrt(p.teamSize)) ;
  return need / p.timelineWeeks * 2;
}

export function detectRisks(p: ProposalInput, points: number): Risk[] {
  const out: Risk[] = [];
  const risk = (category: RiskCategory, severity: Severity, title: string, detail: string, impact: number) => out.push({ category, severity, title, detail, impact });
  const tight = tightness(p);
  if (p.newTechnologies.length) risk("technical", p.newTechnologies.length > 1 ? "high" : "medium", "New technology", `The team has not shipped with ${p.newTechnologies.join(", ")} before.`, p.newTechnologies.length > 1 ? 10 : 6);
  if (p.systemsTouched >= 3) risk("technical", p.systemsTouched >= 5 ? "high" : "medium", "Many systems change together", `${p.systemsTouched} systems must change and stay compatible.`, p.systemsTouched >= 5 ? 9 : 5);
  if (p.teamHasExpertise === "no") risk("resource", "high", "Missing expertise", "The team says it lacks the skills this needs.", 12);
  if (tight >= 1 && p.teamSize <= 2) risk("resource", tight >= 1.5 ? "high" : "medium", "Tight timeline, small team", `${p.teamSize} ${p.teamSize === 1 ? "person" : "people"} for ${p.timelineWeeks} weeks leaves no slack.`, tight >= 1.5 ? 12 : 7);
  else if (tight >= 1.5) risk("timeline", "high", "Timeline looks too short", "The scope needs more weeks than planned for this team size.", 10);
  if (p.requirements === "unclear") risk("budget", "high", "Unclear requirements", "Unclear requirements are the usual cause of rework and overruns.", 12);
  else if (p.requirements === "partial") risk("budget", "medium", "Requirements partly defined", "Parts of the scope are still open.", 5);
  const vague = count(VAGUE_RE, p.description), creep = count(CREEP_RE, p.description);
  if (vague + creep >= 3) risk("budget", "medium", "Scope creep wording", `The description uses open-ended wording ${vague + creep} times (also, etc, maybe, nice to have).`, 6);
  if (p.budgetJustified === "no") risk("budget", "medium", "Budget not justified", "The spend has no agreed business case.", 6);
  if (points >= 13 && p.timelineWeeks <= 4) risk("timeline", "high", "Big work in a short window", `${points} points in ${p.timelineWeeks} weeks means several things must merge close together, with little room for blockers.`, 8);
  if (p.externalDependencies.length) risk("dependency", p.externalDependencies.length >= 3 ? "high" : "medium", "Waiting on third parties", `Depends on ${p.externalDependencies.join(", ")}; their delays are outside the team's control.`, Math.min(12, p.externalDependencies.length * 4));
  if ((p.compliance || count(COMPLIANCE_RE, p.description) >= 2) && !p.legalSignOff) risk("dependency", "high", "No legal sign-off", "Compliance work should not start before counsel has signed off the approach.", 10);
  if (count(INTEGRATION_RE, p.description) >= 2 && p.externalDependencies.length === 0) risk("technical", "medium", "Integration not listed as a dependency", "The scope mentions external integrations but none are listed under dependencies.", 4);
  return out.sort((a, b) => b.impact - a.impact);
}

export function compareHistory(points: number, weeksPlanned: number, history: readonly HistoryProject[]): Comparison {
  const c: Comparison = { enough: history.length >= MIN_HISTORY, projectsUsed: history.length, similarCount: 0, similarWeeks: null, velocity: null, weeksAtVelocity: null, teamSuccessRate: null, messages: [] };
  if (!c.enough) { c.messages.push(`Only ${history.length} finished project${history.length === 1 ? "" : "s"} on file. Elena needs ${MIN_HISTORY} before she compares.`); return c; }
  const idx = POINT_SCALE.indexOf(points as Points);
  const similar = history.filter(h => Math.abs(POINT_SCALE.indexOf(ceilStep(h.points)) - idx) <= 1);
  c.similarCount = similar.length;
  if (similar.length) {
    const w = similar.map(h => h.weeks);
    c.similarWeeks = { min: Math.min(...w), max: Math.max(...w) };
    const avg = w.reduce((a, b) => a + b, 0) / w.length;
    const avgPts = similar.reduce((a, h) => a + h.points, 0) / similar.length;
    c.messages.push(`Similar projects took ${c.similarWeeks.min === c.similarWeeks.max ? `${c.similarWeeks.min}` : `${c.similarWeeks.min}-${c.similarWeeks.max}`} weeks. This one is ${points} points against their average of ${round1(avgPts)}${avg > weeksPlanned ? `, and you have planned ${weeksPlanned}` : ""}.`);
  } else c.messages.push("No finished project is about this size, so there is nothing close to compare with.");
  const totalPts = history.reduce((a, h) => a + h.points, 0), totalWeeks = history.reduce((a, h) => a + h.weeks, 0);
  if (totalWeeks > 0) {
    c.velocity = round1(totalPts / totalWeeks);
    c.weeksAtVelocity = Math.max(1, Math.ceil(points / c.velocity));
    c.messages.push(`Your team's velocity is ${c.velocity} points a week. At that pace ${points} points takes about ${c.weeksAtVelocity} week${c.weeksAtVelocity === 1 ? "" : "s"}${c.weeksAtVelocity > weeksPlanned ? `, longer than the ${weeksPlanned} planned` : ""}.`);
  }
  c.teamSuccessRate = Math.round((history.filter(h => h.outcome === "succeeded").length / history.length) * 100);
  return c;
}

/** Starts at 70, subtracts each risk's impact, adds credit for sign-off and clear requirements, then nudges toward the team's record. */
export function successProbability(p: ProposalInput, risks: readonly Risk[], cmp: Comparison): number {
  let s = BASE_SUCCESS - risks.reduce((a, r) => a + r.impact, 0);
  if (p.requirements === "clear") s += 5;
  if (p.compliance && p.legalSignOff) s += 4;
  if (p.teamHasExpertise === "yes") s += 4;
  if (p.budgetJustified === "yes") s += 2;
  if (cmp.enough && cmp.teamSuccessRate !== null) s += clamp(Math.round((cmp.teamSuccessRate - BASE_SUCCESS) / 3), -6, 6);
  if (cmp.weeksAtVelocity !== null && cmp.weeksAtVelocity > p.timelineWeeks * 1.5) s -= 8;
  return clamp(Math.round(s), 5, 95);
}

function checklist(p: ProposalInput, risks: readonly Risk[], cmp: Comparison): CheckItem[] {
  const has = (t: string) => risks.some(r => r.title === t);
  const yn = (ok: boolean): "yes" | "no" => (ok ? "yes" : "no");
  return [
    { key: "expertise", label: "Team expertise available", status: p.teamHasExpertise, note: p.newTechnologies.length ? `New: ${p.newTechnologies.join(", ")}` : "No new technology listed" },
    { key: "budget", label: "Budget justified", status: p.budgetJustified, note: "Elena does not forecast spend" },
    { key: "requirements", label: "Requirements clear", status: p.requirements === "clear" ? "yes" : p.requirements === "unclear" ? "no" : "unknown", note: p.requirements === "partial" ? "Partly defined" : "" },
    { key: "creep", label: "Scope creep under control", status: yn(!has("Scope creep wording") && p.requirements !== "unclear"), note: has("Scope creep wording") ? "Open-ended wording in the scope" : "" },
    { key: "dependencies", label: "External dependencies clear", status: p.externalDependencies.length === 0 && !has("Integration not listed as a dependency") ? "yes" : p.externalDependencies.length ? "unknown" : "no", note: p.externalDependencies.length ? `${p.externalDependencies.length} to confirm with owners` : "" },
    { key: "timeline", label: "Timeline realistic", status: yn(!has("Timeline looks too short") && !has("Tight timeline, small team") && !has("Big work in a short window") && !(cmp.weeksAtVelocity !== null && cmp.weeksAtVelocity > p.timelineWeeks)), note: cmp.weeksAtVelocity !== null ? `Velocity says about ${cmp.weeksAtVelocity} weeks` : "" }
  ];
}

function recommend(p: ProposalInput, points: number, risks: readonly Risk[], cmp: Comparison): string[] {
  const r: string[] = [], has = (t: string) => risks.some(x => x.title === t);
  if (points >= 13 || p.timelineWeeks > 4) r.push("Break it into 2-week sprints, each with something that can ship.");
  if (points >= 21) r.push("Reduce scope: this is the top of the scale. Cut the lowest-value feature, or split it into two projects.");
  if (has("No legal sign-off")) r.push("Get legal sign-off before starting.");
  if (has("Missing expertise") || p.newTechnologies.length > 1) r.push("Hire or borrow an external consultant for the new technology, or run a short spike first.");
  if (has("Tight timeline, small team") || has("Timeline looks too short")) r.push("Increase the team size, or move the deadline. Do not squeeze the testing.");
  if (has("Unclear requirements") || has("Requirements partly defined")) r.push("Write acceptance criteria for each feature before any code.");
  if (has("Scope creep wording")) r.push("Freeze the scope: list what is out as well as what is in.");
  if (p.externalDependencies.length) r.push("Confirm dates and sandbox access with each third party in week one.");
  if (cmp.weeksAtVelocity !== null && cmp.weeksAtVelocity > p.timelineWeeks) r.push(`Plan for about ${cmp.weeksAtVelocity} weeks, or cut scope to fit ${p.timelineWeeks}.`);
  if (!r.length) r.push("No blockers found. Start, and re-check after the first sprint.");
  return r;
}

export function analyseProposal(p: ProposalInput, history: readonly HistoryProject[] = []): Analysis {
  const { points, raw, factors } = scoreComplexity(p);
  const risks = detectRisks(p, points);
  const comparison = compareHistory(points, p.timelineWeeks, history);
  const probability = successProbability(p, risks, comparison);
  if (comparison.enough && comparison.teamSuccessRate !== null) comparison.messages.push(`Your team's success rate is ${comparison.teamSuccessRate}%. This project: ${probability}% probability.`);
  const notes = ["Rules only, not a prediction model. It advises; people decide.", "Budget forecasts, resource assignment and contract risk are not covered."];
  return { engine: ENGINE_VERSION, points, rawScore: raw, band: bandOf(points), successProbability: probability, factors, risks, recommendations: recommend(p, points, risks, comparison), checklist: checklist(p, risks, comparison), comparison, notes };
}

export function parseHistory(b: Record<string, unknown> | null): { ok: true; value: HistoryProject } | { ok: false; error: string } {
  const name = str(b?.["name"]), points = whole(b?.["points"], 1, 21), weeks = whole(b?.["weeks"], 1, 104), outcome = oneOf(b?.["outcome"], ["succeeded", "failed"], "succeeded");
  if (!name || name.length > LIM.title) return { ok: false, error: `Name the project in up to ${LIM.title} characters.` };
  if (points === null) return { ok: false, error: "Points must be a whole number from 1 to 21." };
  if (weeks === null) return { ok: false, error: "Weeks must be a whole number from 1 to 104." };
  if (!outcome) return { ok: false, error: "The outcome is succeeded or failed." };
  return { ok: true, value: { name, points, weeks, outcome } };
}
