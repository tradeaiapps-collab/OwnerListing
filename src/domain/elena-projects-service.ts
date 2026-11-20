import type { ObjectStoragePort } from "../adapters/object-storage";
import {
  answerQuestion, draftUpdate, LIMITS, NOT_ADVICE, projectPassages, reviewProject, toPassages, validateQuestion, validateReply, validateUpdate,
  type Answer, type Outcome, type Passage, type ReviewDoc, type ReviewFlag, type Source
} from "./elena-projects";
import type { InvestmentDeps } from "./investment-service";
import type { InvestmentProject } from "./investor-projects";
import type { Actor, Failure, Result } from "./listing-service";
import { mayViewDoc, viewerOf, type ProjectDocRecord, type ProjectDocStore, type Viewer } from "./project-documents";
import { withinLimit } from "./rate-limit";

/**
 * Service for Elena on investor projects. Same access rules as the project and its documents (viewerOf): investors must pass viewProject,
 * the owner is the owner, everyone else gets "not found". Elena reads only current, investor-visible documents whose latest address
 * masking revision staff confirmed, and she reads them through the masking terms, so what she quotes is what an investor could read.
 */
export interface QuestionRecord {
  id: string; projectId: string; askerUserId: string; question: string; answer: string; outcome: Outcome; reason?: string; sources: Source[]; createdAt: string;
}
export interface ReplyRecord { id: string; questionId: string; ownerUserId: string; body: string; createdAt: string }
export interface UpdateRecord {
  id: string; projectId: string; title: string; body: string; status: "draft" | "published"; sourceDocIds: string[]; createdBy: "elena" | "owner";
  createdByUser: string; approvedBy?: string; approvedAt?: string; createdAt: string;
}
export interface QuestionView extends Omit<QuestionRecord, "askerUserId" | "projectId"> { replies: Omit<ReplyRecord, "ownerUserId" | "questionId">[]; mine?: boolean }

export interface ElenaProjectStore {
  addQuestion(q: QuestionRecord): Promise<void>;
  /** Newest first, at most 200. `askerId` limits to one investor's own. */
  questionsFor(projectId: string, askerId?: string): Promise<QuestionRecord[]>;
  questionById(id: string): Promise<QuestionRecord | undefined>;
  addReply(r: ReplyRecord): Promise<void>;
  repliesFor(questionIds: readonly string[]): Promise<ReplyRecord[]>;
  addUpdate(u: UpdateRecord): Promise<void>;
  updatesFor(projectId: string, includeDrafts: boolean): Promise<UpdateRecord[]>;
  updateById(id: string): Promise<UpdateRecord | undefined>;
  /** Only while it is still a draft. False when it was already published (or is gone). */
  saveDraft(id: string, title: string, body: string, at: string): Promise<boolean>;
  /** Draft to published, once. False when it was not a draft. */
  publish(id: string, approverId: string, at: string): Promise<boolean>;
  setFollow(projectId: string, userId: string, on: boolean, at: string): Promise<void>;
  isFollowing(projectId: string, userId: string): Promise<boolean>;
  followers(projectId: string, limit: number): Promise<string[]>;
}

/** Plain text of each page of a stored document (empty for images and scans). */
export interface DocTextPort { pages(bytes: Uint8Array, mime: string): Promise<string[]> }
export interface ElenaPorts { storage: ObjectStoragePort; text: DocTextPort }

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const NOT_FOUND = fail("not_found", "Not found.");
const isFail = <T>(x: T | Failure): x is Failure => typeof x === "object" && x !== null && "ok" in x && (x as { ok: unknown }).ok === false;

interface Ctx { project: InvestmentProject; viewer: Exclude<Viewer, null> }
async function context(deps: InvestmentDeps, actor: Actor, projectId: string): Promise<Ctx | Failure> {
  const project = await deps.repo.getProject(projectId);
  if (!project) return NOT_FOUND;
  const viewer = await viewerOf(deps, actor, projectId, project.ownerUserId);
  return viewer ? { project, viewer } : NOT_FOUND;
}
const audit = (deps: InvestmentDeps, actorId: string, projectId: string, eventType: string, payload: Record<string, unknown>) =>
  deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId, aggregateType: "investment_project", aggregateId: projectId, eventType, correlationId: deps.newId(), payload });
const safeNotify = (deps: InvestmentDeps, userId: string, template: string, subject: string, text: string) => deps.notify(userId, template, subject, text).catch(() => undefined);
const projectLink = (deps: InvestmentDeps, id: string, tail = "") => `${deps.appUrl}/investments/${id}${tail}`;

// ---- Reading the published documents --------------------------------------------------------------------------------------------

interface ReadableDoc { doc: ProjectDocRecord; pages: string[]; terms: readonly string[] }
const cache = new Map<string, string[]>();
const CACHE_MAX = 60;

/** Current investor-visible documents with a confirmed mask, as text by page. A document that cannot be read is skipped, never guessed at. */
async function readableDocs(deps: InvestmentDeps, docs: ProjectDocStore, ports: ElenaPorts, projectId: string): Promise<ReadableDoc[]> {
  const all = await docs.documentsFor(projectId);
  const replaced = new Set(all.map(d => d.supersedesId).filter(Boolean));
  const out: ReadableDoc[] = [];
  for (const doc of all.filter(d => d.visibility === "investors" && !replaced.has(d.id) && mayViewDoc("investor", d.visibility)).slice(-LIMITS.maxDocs)) {
    const mask = await docs.latestMask(doc.id);
    if (!mask?.confirmed) continue;
    const key = `${doc.id}:${mask.id}`;
    let pages = cache.get(key);
    if (!pages) {
      try {
        const file = await docs.storedFile(doc.id);
        if (!file || !ports.storage.configured) continue;
        pages = await ports.text.pages(await ports.storage.get(file.storageKey), file.contentType);
      } catch { continue; }
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(key, pages);
    }
    out.push({ doc, pages, terms: mask.terms });
  }
  void deps;
  return out;
}

const docPassages = (r: ReadableDoc): Passage[] => r.pages.flatMap((t, i) => toPassages(r.doc.id, r.doc.title, i + 1, t, r.terms));

// ---- Investor questions ---------------------------------------------------------------------------------------------------------

export interface AskResult { id: string; outcome: Outcome; text: string; sources: Source[]; notice: string }

/** An investor asks Elena. Rate limited; checked by the content filter; always logged (except refused text, which is never stored). */
export async function askElena(
  deps: InvestmentDeps, store: ElenaProjectStore, docs: ProjectDocStore, ports: ElenaPorts, actor: Actor, projectId: string, rawQuestion: unknown
): Promise<Result<AskResult>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c)) return c;
  if (c.viewer !== "investor") return fail("forbidden", "Owners read investor questions on the Elena page.");
  if (!withinLimit(await deps.countHit(`elena-project-ask:${actor.userId}`, 60 * 60 * 1000).catch(() => undefined), LIMITS.askPerHour))
    return fail("rate_limited", "You have asked a lot of questions in a short time. Please try again later.");
  const q = validateQuestion(rawQuestion);
  if (!q.ok) return fail("invalid", q.error);
  const guard = await deps.contentGuard?.({ userId: actor.userId, text: q.value });
  if (guard && !guard.ok) return fail("invalid", guard.message);

  const readable = await readableDocs(deps, docs, ports, projectId);
  const terms = readable.flatMap(r => r.terms);
  const answer: Answer = answerQuestion(q.value, [...projectPassages(c.project), ...readable.flatMap(docPassages)], terms);
  const id = deps.newId();
  await store.addQuestion({
    id, projectId, askerUserId: actor.userId, question: q.value, answer: answer.text, outcome: answer.outcome, ...(answer.reason ? { reason: answer.reason } : {}),
    sources: answer.sources, createdAt: deps.now()
  });
  if (guard?.ok && guard.after) await guard.after(id).catch(() => undefined);
  await audit(deps, actor.userId, projectId, "investment.elena_question", { questionId: id, outcome: answer.outcome, reason: answer.reason ?? null, sources: answer.sources.length });
  if (answer.outcome === "escalated")
    await safeNotify(deps, c.project.ownerUserId, "elena_project_question", "An investor has a question about your project",
      `An investor asked a question Elena could not answer from your published material. Open Elena on your project to read it and reply: ${projectLink(deps, projectId, "/elena")}`);
  return { ok: true, value: { id, outcome: answer.outcome, text: answer.text, sources: answer.sources, notice: NOT_ADVICE } };
}

/** The owner sees every question with replies; an investor sees only their own. */
export async function listQuestions(deps: InvestmentDeps, store: ElenaProjectStore, actor: Actor, projectId: string): Promise<Result<{ questions: QuestionView[]; role: "owner" | "investor" }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c)) return c;
  if (c.viewer === "staff") return NOT_FOUND;
  const rows = await store.questionsFor(projectId, c.viewer === "owner" ? undefined : actor.userId);
  const replies = await store.repliesFor(rows.map(r => r.id));
  return { ok: true, value: { role: c.viewer === "owner" ? "owner" : "investor", questions: rows.map(r => ({
    id: r.id, question: r.question, answer: r.answer, outcome: r.outcome, sources: r.sources, createdAt: r.createdAt, ...(r.reason ? { reason: r.reason } : {}),
    replies: replies.filter(x => x.questionId === r.id).map(x => ({ id: x.id, body: x.body, createdAt: x.createdAt }))
  })) } };
}

/** Owner answers a question that Elena passed on. The asker is told by email notice (no text in the email). */
export async function replyToQuestion(deps: InvestmentDeps, store: ElenaProjectStore, actor: Actor, projectId: string, questionId: string, raw: unknown): Promise<Result<{ id: string }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  const q = await store.questionById(questionId);
  if (!q || q.projectId !== projectId) return NOT_FOUND;
  if (!withinLimit(await deps.countHit(`elena-project-reply:${actor.userId}`, 60 * 60 * 1000).catch(() => undefined), 30)) return fail("rate_limited", "Too many replies. Try again later.");
  const v = validateReply(raw);
  if (!v.ok) return fail("invalid", v.error);
  const guard = await deps.contentGuard?.({ userId: actor.userId, text: v.value });
  if (guard && !guard.ok) return fail("invalid", guard.message);
  const id = deps.newId();
  await store.addReply({ id, questionId, ownerUserId: actor.userId, body: v.value, createdAt: deps.now() });
  if (guard?.ok && guard.after) await guard.after(id).catch(() => undefined);
  await audit(deps, actor.userId, projectId, "investment.elena_question_replied", { questionId, replyId: id });
  await safeNotify(deps, q.askerUserId, "elena_project_reply", "The project owner replied to your question",
    `The owner of ${c.project.title} replied to your question. Read it here: ${projectLink(deps, projectId)}`);
  return { ok: true, value: { id } };
}

// ---- Keeping the project current ------------------------------------------------------------------------------------------------

async function currentDocs(docs: ProjectDocStore, projectId: string): Promise<ReviewDoc[]> {
  const all = await docs.documentsFor(projectId);
  const replaced = new Set(all.map(d => d.supersedesId).filter(Boolean));
  const out: ReviewDoc[] = [];
  for (const d of all.filter(x => !replaced.has(x.id))) {
    const m = d.visibility === "investors" ? await docs.latestMask(d.id) : undefined;
    out.push({ ...d, masking: d.visibility !== "investors" ? "not_needed" : m?.confirmed ? "confirmed" : "pending" });
  }
  return out;
}

/** Owner only: what Elena thinks is missing or stale. */
export async function reviewForOwner(deps: InvestmentDeps, store: ElenaProjectStore, docs: ProjectDocStore, actor: Actor, projectId: string): Promise<Result<{ flags: ReviewFlag[]; newDocuments: number }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  const updates = await store.updatesFor(projectId, true);
  const lastPublished = updates.filter(u => u.status === "published").map(u => u.approvedAt ?? u.createdAt).sort().pop();
  const current = await currentDocs(docs, projectId);
  const since = updates.map(u => u.createdAt).sort().pop();
  const fresh = current.filter(d => d.visibility === "investors" && d.masking === "confirmed" && (!since || d.uploadedAt > since));
  return { ok: true, value: { flags: reviewProject(c.project, current, lastPublished, deps.now()), newDocuments: fresh.length } };
}

/** Owner asks Elena for a draft update from documents added since the last update. The draft is private to the owner until approved. */
export async function draftForOwner(deps: InvestmentDeps, store: ElenaProjectStore, docs: ProjectDocStore, ports: ElenaPorts, actor: Actor, projectId: string): Promise<Result<UpdateRecord>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  if (c.project.status === "rejected") return fail("forbidden", "This project was rejected.");
  if (!withinLimit(await deps.countHit(`elena-project-draft:${actor.userId}`, 24 * 60 * 60 * 1000).catch(() => undefined), LIMITS.draftPerDay)) return fail("rate_limited", "Too many drafts today. Try again tomorrow.");
  const updates = await store.updatesFor(projectId, true);
  if (updates.some(u => u.status === "draft")) return fail("conflict", "You already have a draft update. Edit and approve it, or keep editing it.");
  const since = updates.map(u => u.createdAt).sort().pop();
  const readable = (await readableDocs(deps, docs, ports, projectId)).filter(r => !since || r.doc.uploadedAt > since).slice(-5);
  const draft = draftUpdate(c.project, readable.map(r => ({ id: r.doc.id, title: r.doc.title, kind: r.doc.kind, uploadedAt: r.doc.uploadedAt, text: r.pages.join("\n"), terms: r.terms })), deps.now());
  if (!draft) return fail("invalid", "There are no new documents visible to investors since your last update. Add a document, or wait until reviewers confirm its masking.");
  const check = validateUpdate(draft);
  if (!check.ok) return fail("invalid", check.error);
  const rec: UpdateRecord = { id: deps.newId(), projectId, ...check.value, status: "draft", sourceDocIds: draft.sourceDocIds, createdBy: "elena", createdByUser: actor.userId, createdAt: deps.now() };
  await store.addUpdate(rec);
  await audit(deps, actor.userId, projectId, "investment.project_update_drafted", { updateId: rec.id, documents: draft.sourceDocIds.length });
  return { ok: true, value: rec };
}

export async function editDraft(deps: InvestmentDeps, store: ElenaProjectStore, actor: Actor, projectId: string, updateId: string, raw: unknown): Promise<Result<UpdateRecord>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  const u = await store.updateById(updateId);
  if (!u || u.projectId !== projectId) return NOT_FOUND;
  if (u.status !== "draft") return fail("conflict", "A published update cannot be changed. Publish a new update instead.");
  const v = validateUpdate(raw);
  if (!v.ok) return fail("invalid", v.error);
  if (!(await store.saveDraft(updateId, v.value.title, v.value.body, deps.now()))) return fail("conflict", "That update was already published.");
  return { ok: true, value: { ...u, ...v.value } };
}

/**
 * The owner approves a draft: it is published to investors who can see the project, and only then are followers notified (a notice with a
 * link, never the text). Needs an approved project so investors can see it.
 */
export async function approveUpdate(deps: InvestmentDeps, store: ElenaProjectStore, actor: Actor, projectId: string, updateId: string): Promise<Result<{ notified: number }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  const u = await store.updateById(updateId);
  if (!u || u.projectId !== projectId) return NOT_FOUND;
  if (c.project.status !== "approved") return fail("conflict", "Updates can be published once staff have approved the project.");
  const v = validateUpdate(u);
  if (!v.ok) return fail("invalid", v.error);
  if (!(await store.publish(updateId, actor.userId, deps.now()))) return fail("conflict", "That update was already published.");
  await audit(deps, actor.userId, projectId, "investment.project_update_published", { updateId });
  let notified = 0;
  for (const userId of await store.followers(projectId, LIMITS.maxFollowersNotified)) {
    if ((await viewerOf(deps, { userId, userType: "buyer" }, projectId, c.project.ownerUserId).catch(() => null)) !== "investor") continue;
    await safeNotify(deps, userId, "project_update", `New update on ${c.project.title}`, `A project you follow has a new update: ${u.title}. Read it here: ${projectLink(deps, projectId)}`);
    notified++;
  }
  return { ok: true, value: { notified } };
}

/** Owner: all updates including drafts. Investor: published only, plus whether they follow. */
export async function listUpdates(deps: InvestmentDeps, store: ElenaProjectStore, actor: Actor, projectId: string): Promise<Result<{ updates: Omit<UpdateRecord, "createdByUser" | "approvedBy">[]; following: boolean; role: "owner" | "investor" }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer === "staff") return NOT_FOUND;
  const rows = await store.updatesFor(projectId, c.viewer === "owner");
  return { ok: true, value: {
    role: c.viewer === "owner" ? "owner" : "investor", following: c.viewer === "investor" && (await store.isFollowing(projectId, actor.userId)),
    updates: rows.map(({ createdByUser: _a, approvedBy: _b, ...rest }) => rest)
  } };
}

export async function setFollow(deps: InvestmentDeps, store: ElenaProjectStore, actor: Actor, projectId: string, on: boolean): Promise<Result<{ following: boolean }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "investor") return NOT_FOUND;
  if (!withinLimit(await deps.countHit(`elena-project-follow:${actor.userId}`, 60 * 60 * 1000).catch(() => undefined), 30)) return fail("rate_limited", "Too many changes. Try again later.");
  await store.setFollow(projectId, actor.userId, on, deps.now());
  return { ok: true, value: { following: on } };
}

export function createInMemoryElenaStore(): ElenaProjectStore & { questions: QuestionRecord[]; updates: UpdateRecord[]; follows: Set<string> } {
  const questions: QuestionRecord[] = [], replies: ReplyRecord[] = [], updates: UpdateRecord[] = [], follows = new Set<string>();
  const key = (p: string, u: string) => `${p}|${u}`;
  return {
    questions, updates, follows,
    async addQuestion(q) { questions.push(q); },
    async questionsFor(p, a) { return questions.filter(q => q.projectId === p && (!a || q.askerUserId === a)).slice().reverse().slice(0, 200); },
    async questionById(id) { return questions.find(q => q.id === id); },
    async addReply(r) { replies.push(r); },
    async repliesFor(ids) { return replies.filter(r => ids.includes(r.questionId)); },
    async addUpdate(u) { updates.push(u); },
    async updatesFor(p, d) { return updates.filter(u => u.projectId === p && (d || u.status === "published")).slice().reverse(); },
    async updateById(id) { return updates.find(u => u.id === id); },
    async saveDraft(id, title, body) { const u = updates.find(x => x.id === id); if (!u || u.status !== "draft") return false; u.title = title; u.body = body; return true; },
    async publish(id, by, at) { const u = updates.find(x => x.id === id); if (!u || u.status !== "draft") return false; u.status = "published"; u.approvedBy = by; u.approvedAt = at; return true; },
    async setFollow(p, u, on) { if (on) follows.add(key(p, u)); else follows.delete(key(p, u)); },
    async isFollowing(p, u) { return follows.has(key(p, u)); },
    async followers(p) { return [...follows].filter(k => k.startsWith(`${p}|`)).map(k => k.split("|")[1]!); }
  };
}
