import type { ObjectStoragePort } from "../adapters/object-storage";
import { buildDiligence, DILIGENCE_ENGINE_VERSION, DILIGENCE_NOTICE, scrubForInvestor, summaryLeaks, validateNote, type DiligenceInputDoc, type DiligencePendingDoc, type DiligenceSummary } from "./elena-diligence";
import type { DocTextPort } from "./elena-projects-service";
import type { InvestmentDeps } from "./investment-service";
import type { InvestmentProject } from "./investor-projects";
import type { Actor, Failure, Result } from "./listing-service";
import { mayViewDoc, viewerOf, type ProjectDocStore, type Viewer } from "./project-documents";
import { withinLimit } from "./rate-limit";

/**
 * Service for Elena's due-diligence summary. Same access rules as the project and its documents: investors must pass viewProject, the owner
 * is the developer, everyone else gets "not found". Elena reads only current investor-visible documents whose latest address masking staff
 * confirmed. Investors read only a published summary, and only after it passes the leak check again.
 */
export const DILIGENCE_PER_DAY = 6;
const MAX_DOCS = 12;

export interface DiligenceRecord {
  id: string; projectId: string; status: "draft" | "published"; summary: DiligenceSummary; developerNote: string; sourceKeys: string[]; engineVersion: number;
  createdByUser: string; approvedBy?: string; approvedAt?: string; createdAt: string; updatedAt: string;
}
export interface DiligenceStore {
  /** Latest first. */
  listFor(projectId: string, includeDrafts: boolean): Promise<DiligenceRecord[]>;
  byId(id: string): Promise<DiligenceRecord | undefined>;
  /** Creates the draft, or rewrites the existing draft (the one-draft rule is in the database too). */
  saveDraft(r: DiligenceRecord): Promise<DiligenceRecord>;
  setNote(id: string, note: string, at: string): Promise<boolean>;
  /** Draft to published, once. False when it was not a draft. */
  publish(id: string, approverId: string, at: string): Promise<boolean>;
}
export interface DiligencePorts { storage: ObjectStoragePort; text: DocTextPort }

export interface DiligenceView {
  id: string; status: "draft" | "published"; summary: DiligenceSummary; developerNote: string; approvedAt?: string; createdAt: string;
  /** The documents changed after this summary was made. */
  outdated: boolean; notice: string;
}

const fail = (code: Failure["code"], message: string): Failure => ({ ok: false, code, message });
const NOT_FOUND = fail("not_found", "Not found.");
const isFail = <T>(x: T | Failure): x is Failure => typeof x === "object" && x !== null && "ok" in x && (x as { ok: unknown }).ok === false;
const audit = (deps: InvestmentDeps, actorId: string, projectId: string, eventType: string, payload: Record<string, unknown>) =>
  deps.appendAudit({ id: deps.newId(), occurredAt: deps.now(), actorType: "user", actorId, aggregateType: "investment_project", aggregateId: projectId, eventType, correlationId: deps.newId(), payload });

interface Ctx { project: InvestmentProject; viewer: Exclude<Viewer, null> }
async function context(deps: InvestmentDeps, actor: Actor, projectId: string): Promise<Ctx | Failure> {
  const project = await deps.repo.getProject(projectId);
  if (!project) return NOT_FOUND;
  const viewer = await viewerOf(deps, actor, projectId, project.ownerUserId);
  return viewer ? { project, viewer } : NOT_FOUND;
}

interface Collected { read: DiligenceInputDoc[]; pending: DiligencePendingDoc[]; visible: { id: string; kind: DiligenceInputDoc["kind"]; uploadedAt: string; title: string }[]; keys: string[] }

/** Current investor-visible documents. Those with a confirmed mask are read (text per page); the rest are listed as waiting. Unreadable files give no pages. */
async function collect(docs: ProjectDocStore, ports: DiligencePorts | undefined, projectId: string): Promise<Collected> {
  const all = await docs.documentsFor(projectId);
  const replaced = new Set(all.map(d => d.supersedesId).filter(Boolean));
  const out: Collected = { read: [], pending: [], visible: [], keys: [] };
  for (const doc of all.filter(d => d.visibility === "investors" && !replaced.has(d.id) && mayViewDoc("investor", d.visibility)).slice(-MAX_DOCS)) {
    out.visible.push({ id: doc.id, kind: doc.kind, uploadedAt: doc.uploadedAt, title: doc.title });
    const mask = await docs.latestMask(doc.id);
    if (!mask?.confirmed) { out.pending.push({ id: doc.id, title: doc.title, kind: doc.kind }); continue; }
    out.keys.push(`${doc.id}:${mask.id}`);
    if (!ports) continue;
    let pages: string[] = [];
    try {
      const file = await docs.storedFile(doc.id);
      if (file && ports.storage.configured) pages = await ports.text.pages(await ports.storage.get(file.storageKey), file.contentType);
    } catch { pages = []; }
    out.read.push({ id: doc.id, title: doc.title, kind: doc.kind, uploadedAt: doc.uploadedAt, terms: mask.terms, pages });
  }
  out.keys.sort();
  return out;
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

function toView(r: DiligenceRecord, currentKeys: readonly string[], forInvestor: boolean): DiligenceView {
  return {
    id: r.id, status: r.status, summary: forInvestor ? scrubForInvestor(r.summary) : r.summary, developerNote: r.developerNote,
    ...(r.approvedAt ? { approvedAt: r.approvedAt } : {}), createdAt: r.createdAt, outdated: !sameKeys(r.sourceKeys, [...currentKeys].sort()), notice: DILIGENCE_NOTICE
  };
}

/** Owner: Elena reads the documents and writes (or rewrites) the private draft. Nothing reaches investors until the owner approves it. */
export async function generateDiligence(deps: InvestmentDeps, store: DiligenceStore, docs: ProjectDocStore, ports: DiligencePorts, actor: Actor, projectId: string): Promise<Result<DiligenceView>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  if (c.project.status === "rejected") return fail("forbidden", "This project was rejected.");
  if (!withinLimit(await deps.countHit(`elena-diligence:${actor.userId}`, 24 * 60 * 60 * 1000).catch(() => undefined), DILIGENCE_PER_DAY)) return fail("rate_limited", "Too many summaries today. Try again tomorrow.");
  const got = await collect(docs, ports, projectId);
  const summary = buildDiligence(c.project, got.read, got.pending, got.visible, deps.now());
  if (summaryLeaks(summary)) return fail("invalid", "Elena could not write a summary that keeps the address private. Ask staff to check the masking on your documents.");
  const existing = (await store.listFor(projectId, true)).find(r => r.status === "draft");
  const rec = await store.saveDraft({
    id: existing?.id ?? deps.newId(), projectId, status: "draft", summary, developerNote: existing?.developerNote ?? "", sourceKeys: got.keys, engineVersion: DILIGENCE_ENGINE_VERSION,
    createdByUser: existing?.createdByUser ?? actor.userId, createdAt: existing?.createdAt ?? deps.now(), updatedAt: deps.now()
  });
  await audit(deps, actor.userId, projectId, "investment.diligence_drafted", { summaryId: rec.id, documentsRead: got.read.length });
  return { ok: true, value: toView(rec, got.keys, false) };
}

/** Owner edits their note on a draft. */
export async function saveDiligenceNote(deps: InvestmentDeps, store: DiligenceStore, actor: Actor, projectId: string, id: string, raw: unknown): Promise<Result<{ saved: true }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  const r = await store.byId(id);
  if (!r || r.projectId !== projectId) return NOT_FOUND;
  if (r.status !== "draft") return fail("conflict", "A published summary cannot be changed. Ask Elena for a new one.");
  const v = validateNote(raw);
  if (!v.ok) return fail("invalid", v.error);
  if (!(await store.setNote(id, v.value, deps.now()))) return fail("conflict", "That summary was already published.");
  return { ok: true, value: { saved: true } };
}

/** The owner approves the draft they read: it is published to investors who can see the project (the project must be approved by staff). */
export async function approveDiligence(deps: InvestmentDeps, store: DiligenceStore, actor: Actor, projectId: string, id: string): Promise<Result<{ approved: true }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer !== "owner") return NOT_FOUND;
  const r = await store.byId(id);
  if (!r || r.projectId !== projectId) return NOT_FOUND;
  if (c.project.status !== "approved") return fail("conflict", "A summary can be published once staff have approved the project.");
  if (summaryLeaks(r.summary)) return fail("invalid", "This summary looks like it contains private details. Ask Elena to write it again.");
  if (!(await store.publish(id, actor.userId, deps.now()))) return fail("conflict", "That summary was already published.");
  await audit(deps, actor.userId, projectId, "investment.diligence_published", { summaryId: id });
  return { ok: true, value: { approved: true } };
}

/** Owner: the draft and the latest published summary. Investor: the latest published summary only. Staff and strangers: not found. */
export async function getDiligence(deps: InvestmentDeps, store: DiligenceStore, docs: ProjectDocStore, actor: Actor, projectId: string):
  Promise<Result<{ role: "owner" | "investor"; draft?: DiligenceView; published?: DiligenceView }>> {
  const c = await context(deps, actor, projectId);
  if (isFail(c) || c.viewer === "staff") return NOT_FOUND;
  const owner = c.viewer === "owner";
  const rows = await store.listFor(projectId, owner);
  const draft = owner ? rows.find(r => r.status === "draft") : undefined;
  const pub = rows.find(r => r.status === "published");
  const keys = (await collect(docs, undefined, projectId)).keys;
  return { ok: true, value: { role: owner ? "owner" : "investor", ...(draft ? { draft: toView(draft, keys, false) } : {}), ...(pub ? { published: toView(pub, keys, !owner) } : {}) } };
}

export function createInMemoryDiligenceStore(): DiligenceStore & { rows: DiligenceRecord[] } {
  const rows: DiligenceRecord[] = [];
  return {
    rows,
    async listFor(p, d) { return rows.filter(r => r.projectId === p && (d || r.status === "published")).slice().reverse(); },
    async byId(id) { return rows.find(r => r.id === id); },
    async saveDraft(r) {
      const i = rows.findIndex(x => x.id === r.id);
      if (i >= 0) { if (rows[i]!.status !== "draft") throw new Error("published"); rows[i] = { ...r }; return rows[i]!; }
      rows.push({ ...r }); return r;
    },
    async setNote(id, note, at) { const r = rows.find(x => x.id === id); if (!r || r.status !== "draft") return false; r.developerNote = note; r.updatedAt = at; return true; },
    async publish(id, by, at) { const r = rows.find(x => x.id === id); if (!r || r.status !== "draft") return false; r.status = "published"; r.approvedBy = by; r.approvedAt = at; r.updatedAt = at; return true; }
  };
}
