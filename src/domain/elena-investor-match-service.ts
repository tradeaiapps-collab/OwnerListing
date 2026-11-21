import {
  applyAnswer, emptyPrefs, isComplete, matchProjects, nextStep, promptFor, summarisePrefs, MATCH_NOTICE,
  type InvestorPrefs, type Match, type MatchResult, type Prompt
} from "./elena-investor-match";
import { browse, type InvestmentDeps, type ProjectView } from "./investment-service";
import type { Actor, Failure, Result } from "./listing-service";
import { INVESTMENT_RATE, withinLimit } from "./rate-limit";

/** Stored preferences, one row per investor. The investor can change or delete them. */
export interface InvestorProfileStore {
  get(userId: string): Promise<InvestorPrefs | undefined>;
  save(userId: string, prefs: InvestorPrefs, at: string): Promise<void>;
  remove(userId: string): Promise<void>;
}

export interface MatchCard { match: Match; project: Pick<ProjectView, "id" | "title" | "location" | "jurisdiction" | "projectType" | "stage" | "minimumTicketCents" | "fundingTargetCents" | "issuerName"> }
export interface ElenaMatchState {
  prefs: InvestorPrefs; next: Prompt | null; summary: string; notice: string;
  results: (Omit<MatchResult, "matches"> & { cards: MatchCard[] }) | null;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const audit = (deps: InvestmentDeps, actorId: string, eventType: string, payload: Record<string, unknown>) =>
  deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId, aggregateType: "investor_profile", aggregateId: actorId, eventType, correlationId: deps.newId(), payload });
async function underLimit(deps: InvestmentDeps, userId: string): Promise<boolean> {
  try { return withinLimit(await deps.countHit(`inv-elena:${userId}`, INVESTMENT_RATE.elenaMatch.windowMs), INVESTMENT_RATE.elenaMatch.perUser); } catch { return false; }
}

async function state(prefs: InvestorPrefs, projects: readonly ProjectView[]): Promise<ElenaMatchState> {
  const step = nextStep(prefs);
  if (step) return { prefs, next: promptFor(step), summary: "", notice: MATCH_NOTICE, results: null };
  const { matches, ...rest } = matchProjects(prefs, projects);
  const byId = new Map(projects.map(p => [p.id, p]));
  const cards = matches.flatMap(m => {
    const p = byId.get(m.projectId);
    return p ? [{ match: m, project: { id: p.id, title: p.title, location: p.location, jurisdiction: p.jurisdiction, projectType: p.projectType, stage: p.stage, minimumTicketCents: p.minimumTicketCents, fundingTargetCents: p.fundingTargetCents, issuerName: p.issuerName } }] : [];
  });
  return { prefs, next: null, summary: summarisePrefs(prefs), notice: MATCH_NOTICE, results: { ...rest, cards } };
}

/**
 * Elena's onboarding state for a ready investor: the next question, or, once all four are answered, matching projects.
 * Only projects the investor may already browse are ever considered (same gate as the project list).
 */
export async function getElenaMatch(deps: InvestmentDeps, store: InvestorProfileStore, actor: Actor): Promise<Result<ElenaMatchState>> {
  const list = await browse(deps, actor);
  if (!list.ok) return list;
  return { ok: true, value: await state((await store.get(actor.userId)) ?? emptyPrefs(), list.value) };
}

/** Saves one answer ({ step, value }) and returns the next question or the matches. Any answered step can be changed later. */
export async function answerElena(deps: InvestmentDeps, store: InvestorProfileStore, actor: Actor, raw: unknown): Promise<Result<ElenaMatchState>> {
  const list = await browse(deps, actor);
  if (!list.ok) return list;
  if (!(await underLimit(deps, actor.userId))) return fail("rate_limited", "Too many requests. Try again later.");
  const before = (await store.get(actor.userId)) ?? emptyPrefs();
  const r = applyAnswer(before, raw);
  if (!r.ok) return fail("invalid", r.error);
  await store.save(actor.userId, r.value, deps.now());
  const s = await state(r.value, list.value);
  await audit(deps, actor.userId, "investment.elena_preferences_saved", {
    step: r.step, complete: isComplete(r.value), ...(s.results ? { matchedProjectIds: s.results.cards.map(c => c.project.id) } : {})
  });
  return { ok: true, value: s };
}

/** Deletes the investor's saved preferences. */
export async function resetElena(deps: InvestmentDeps, store: InvestorProfileStore, actor: Actor): Promise<Result<{ cleared: true }>> {
  if (actor.userType !== "buyer") return fail("forbidden", "Use an investor (buyer) account.");
  if (!(await underLimit(deps, actor.userId))) return fail("rate_limited", "Too many requests. Try again later.");
  await store.remove(actor.userId);
  await audit(deps, actor.userId, "investment.elena_preferences_cleared", {});
  return { ok: true, value: { cleared: true } };
}

export function createInMemoryProfileStore(): InvestorProfileStore & { rows: Map<string, InvestorPrefs> } {
  const rows = new Map<string, InvestorPrefs>();
  return {
    rows,
    async get(u) { const p = rows.get(u); return p ? { ...p, suburbs: [...p.suburbs] } : undefined; },
    async save(u, p) { rows.set(u, { ...p, suburbs: [...p.suburbs] }); },
    async remove(u) { rows.delete(u); }
  };
}
