import type { ElenaProjectStore } from "./elena-projects-service";
import { viewProject, type InvestmentDeps } from "./investment-service";
import type { ContractStatus } from "./investment-terms";
import type { Actor, Failure, Result } from "./listing-service";
import type { ProjectDocStore } from "./project-documents";

/**
 * The investor's portfolio page: the projects they follow or have registered interest in, with where each stands. Read only.
 * Nothing here moves money or commits anyone: an "interest" is the non-binding indicative range the investor entered, and
 * Elena's part is limited to what is already on record (her answers, owner replies and owner-approved updates).
 * Access is exactly the project page's: a project the investor may no longer see (withdrawn, rejected, category no longer allowed)
 * is left out, and documents count only while staff have confirmed their address masking.
 */
export const PORTFOLIO_LIMITS = { projects: 30, updatesPerProject: 3, recentDays: 30 } as const;

export interface PortfolioInterest { amountMinCents: number; amountMaxCents: number; contractStatus: ContractStatus; since: string; threadId: string }
export interface PortfolioUpdate { id: string; title: string; publishedAt: string; isNew: boolean }
export interface PortfolioProject {
  id: string; title: string; location: string; jurisdiction: string; stage: string; projectType: string;
  fundingTargetCents: number; minimumTicketCents: number;
  following: boolean; interest?: PortfolioInterest;
  documents: { available: number; waitingForMasking: number; lastAddedAt?: string };
  updates: { items: PortfolioUpdate[]; newCount: number };
  questions: { asked: number; answered: number; passedToOwner: number; ownerReplies: number; recentOwnerReplies: number };
  /** Plain next steps for the investor, most useful first. Never a recommendation to invest. */
  attention: string[];
  lastActivityAt: string;
}
export interface PortfolioSummary {
  projects: number; following: number; interests: number;
  /** Sum of the indicative ranges the investor entered. Not a commitment, not an allocation. */
  indicativeMinCents: number; indicativeMaxCents: number;
  documentsAvailable: number; documentsWaiting: number; newUpdates: number; recentOwnerReplies: number;
}
export interface Portfolio { summary: PortfolioSummary; projects: PortfolioProject[]; truncated: boolean }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const sinceIso = (now: string, days: number) => new Date(new Date(now).getTime() - days * 86_400_000).toISOString();
const latest = (...xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? "";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Next-step lines for one card. Pure, so the wording is tested without a database. */
export function attentionFor(p: Pick<PortfolioProject, "interest" | "documents" | "updates" | "questions">): string[] {
  const out: string[] = [];
  const r = p.questions.recentOwnerReplies;
  if (r > 0) out.push(`The owner replied to your questions ${r === 1 ? "once" : `${r} times`} in the last ${PORTFOLIO_LIMITS.recentDays} days.`);
  if (p.updates.newCount > 0) out.push(`${plural(p.updates.newCount, "new update")} in the last ${PORTFOLIO_LIMITS.recentDays} days.`);
  if (p.interest?.contractStatus === "returned") out.push("Your contract was returned. Open the conversation to see what to change.");
  if (p.interest?.contractStatus === "rejected") out.push("Your contract was rejected. Open the conversation for the reason.");
  const w = p.documents.waitingForMasking;
  if (w > 0) out.push(`${plural(w, "document")} waiting for staff to hide addresses before you can read ${w === 1 ? "it" : "them"}.`);
  if (p.documents.available === 0 && w === 0) out.push("The owner has not published any documents yet.");
  return out;
}

export async function buildPortfolio(
  deps: InvestmentDeps, elena: ElenaProjectStore, docs: ProjectDocStore, actor: Actor
): Promise<Result<Portfolio>> {
  if (actor.userType !== "buyer") return fail("forbidden", "The portfolio is for investor (buyer) accounts.");
  const now = deps.now();
  const recentFrom = sinceIso(now, PORTFOLIO_LIMITS.recentDays);

  const followed = await elena.followedBy(actor.userId, PORTFOLIO_LIMITS.projects + 1);
  const mine = (await deps.repo.threadsFor(actor.userId)).filter(t => t.role === "investor");
  const interestBy = new Map(mine.map(t => [t.interest.projectId, t.interest]));
  const ids = [...new Set([...mine.map(t => t.interest.projectId), ...followed])];
  const truncated = ids.length > PORTFOLIO_LIMITS.projects;

  const built = await Promise.all(ids.slice(0, PORTFOLIO_LIMITS.projects).map(async (id): Promise<PortfolioProject | undefined> => {
    // Same gate as the project page: approved, and the investor's declared category may see it.
    const v = await viewProject(deps, actor, id);
    if (!v.ok || v.value.mine) return undefined;
    const p = v.value.project;

    // Documents: current, investor-visible versions only. Confirmed ones are readable; the rest are counted, never named.
    const all = await docs.documentsFor(id);
    const replaced = new Set(all.map(d => d.supersedesId).filter((x): x is string => !!x));
    const current = all.filter(d => d.visibility === "investors" && !replaced.has(d.id));
    const masks = await Promise.all(current.map(async d => ({ d, confirmed: (await docs.latestMask(d.id))?.confirmed === true })));
    const readable = masks.filter(m => m.confirmed).map(m => m.d);

    const updates = (await elena.updatesFor(id, false)).filter(u => u.status === "published").slice(0, PORTFOLIO_LIMITS.updatesPerProject);
    const items = updates.map(u => { const at = u.approvedAt ?? u.createdAt; return { id: u.id, title: u.title, publishedAt: at, isNew: at >= recentFrom }; });

    const qs = await elena.questionsFor(id, actor.userId);
    const replies = await elena.repliesFor(qs.map(q => q.id));
    const interest = interestBy.get(id);

    const card: PortfolioProject = {
      id, title: p.title, location: p.location, jurisdiction: p.jurisdiction, stage: p.stage, projectType: p.projectType,
      fundingTargetCents: p.fundingTargetCents, minimumTicketCents: p.minimumTicketCents,
      following: followed.includes(id),
      ...(interest ? { interest: { amountMinCents: interest.amountMinCents, amountMaxCents: interest.amountMaxCents, contractStatus: interest.contractStatus, since: interest.createdAt, threadId: mine.find(t => t.interest.id === interest.id)!.interest.id } } : {}),
      documents: { available: readable.length, waitingForMasking: masks.length - readable.length, ...(readable.length ? { lastAddedAt: latest(...readable.map(d => d.uploadedAt)) } : {}) },
      updates: { items, newCount: items.filter(i => i.isNew).length },
      questions: {
        asked: qs.length, answered: qs.filter(q => q.outcome === "answered").length,
        passedToOwner: qs.filter(q => q.outcome === "escalated").length, ownerReplies: replies.length,
        recentOwnerReplies: replies.filter(r => r.createdAt >= recentFrom).length
      },
      attention: [],
      lastActivityAt: latest(interest?.createdAt, ...items.map(i => i.publishedAt), ...readable.map(d => d.uploadedAt), ...qs.map(q => q.createdAt), ...replies.map(r => r.createdAt))
    };
    card.attention = attentionFor(card);
    return card;
  }));

  const projects = built.filter((x): x is PortfolioProject => !!x).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.title.localeCompare(b.title));
  const withInterest = projects.filter(p => p.interest);
  const summary: PortfolioSummary = {
    projects: projects.length, following: projects.filter(p => p.following).length, interests: withInterest.length,
    indicativeMinCents: withInterest.reduce((s, p) => s + p.interest!.amountMinCents, 0),
    indicativeMaxCents: withInterest.reduce((s, p) => s + p.interest!.amountMaxCents, 0),
    documentsAvailable: projects.reduce((s, p) => s + p.documents.available, 0),
    documentsWaiting: projects.reduce((s, p) => s + p.documents.waitingForMasking, 0),
    newUpdates: projects.reduce((s, p) => s + p.updates.newCount, 0),
    recentOwnerReplies: projects.reduce((s, p) => s + p.questions.recentOwnerReplies, 0)
  };
  return { ok: true, value: { summary, projects, truncated } };
}
