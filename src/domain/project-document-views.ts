import { viewerOf, type ProjectDocRecord, type ProjectDocStore } from "./project-documents";
import type { InvestmentDeps } from "./investment-service";
import type { Actor, Result } from "./listing-service";

/**
 * Document room: version numbers and the investor view log.
 * Only investors are logged (not the owner or staff). Re-opening the same document inside DEDUPE_MS is one view, so a reload does not
 * inflate the count. Only the project owner can read the log; everyone else gets "not found". Logging never blocks reading.
 */
export const VIEW_DEDUPE_MS = 10 * 60 * 1000;
export const VIEW_LOG_LIMIT = 500;

export interface ViewSummary { documentId: string; title: string; version: number; investorId: string; investorName: string; opens: number; firstAt: string; lastAt: string }
export interface ViewRow { documentId: string; viewerId: string; viewerName: string; viewedAt: string }

/** Insert only. */
export interface ProjectDocViewStore {
  /** Adds a view unless the same viewer already has one for the document at or after `dedupeSinceIso`. Returns whether a row was added. */
  addView(v: { id: string; documentId: string; projectId: string; viewerId: string; viewedAt: string }, dedupeSinceIso: string): Promise<boolean>;
  /** Newest first, at most `limit` rows. */
  viewsFor(projectId: string, limit: number): Promise<ViewRow[]>;
}

/** 1 for the first upload of a document, 2 for its replacement, and so on, keyed by document id. */
export function versionNumbers(docs: { id: string; supersedesId?: string | undefined }[]): Map<string, number> {
  const byId = new Map(docs.map(d => [d.id, d]));
  const out = new Map<string, number>();
  const depth = (id: string, guard = 0): number => {
    const known = out.get(id);
    if (known) return known;
    const d = byId.get(id);
    const v = d?.supersedesId && byId.has(d.supersedesId) && guard < 200 ? depth(d.supersedesId, guard + 1) + 1 : 1;
    out.set(id, v);
    return v;
  };
  for (const d of docs) depth(d.id);
  return out;
}

/** Called when an investor opens a document. Best effort: any failure is swallowed so the document still opens. */
export async function recordDocumentView(
  deps: InvestmentDeps, docs: ProjectDocStore, views: ProjectDocViewStore, actor: Actor, docId: string
): Promise<void> {
  try {
    const doc = await docs.documentById(docId);
    const p = doc ? await deps.repo.getProject(doc.projectId) : undefined;
    if (!doc || !p) return;
    if ((await viewerOf(deps, actor, p.id, p.ownerUserId)) !== "investor") return;
    const now = deps.now();
    await views.addView({ id: deps.newId(), documentId: doc.id, projectId: p.id, viewerId: actor.userId, viewedAt: now }, new Date(Date.parse(now) - VIEW_DEDUPE_MS).toISOString());
  } catch (e) { console.error("document view not recorded", e instanceof Error ? e.message : e); }
}

/** Owner only: who opened which document, one line per investor and document (count, first and last open), most recent first. */
export async function listDocumentViews(
  deps: InvestmentDeps, docs: ProjectDocStore, views: ProjectDocViewStore, actor: Actor, projectId: string
): Promise<Result<{ views: ViewSummary[]; truncated: boolean }>> {
  const p = await deps.repo.getProject(projectId);
  if (!p || p.ownerUserId !== actor.userId) return { ok: false, code: "not_found", message: "Project not found." };
  const [all, rows] = await Promise.all([docs.documentsFor(projectId), views.viewsFor(projectId, VIEW_LOG_LIMIT + 1)]);
  const byDoc = new Map<string, ProjectDocRecord>(all.map(d => [d.id, d]));
  const version = versionNumbers(all);
  const truncated = rows.length > VIEW_LOG_LIMIT;
  const groups = new Map<string, ViewSummary>();
  for (const r of rows.slice(0, VIEW_LOG_LIMIT)) {
    const d = byDoc.get(r.documentId);
    if (!d) continue;
    const key = `${r.documentId}:${r.viewerId}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { documentId: d.id, title: d.title, version: version.get(d.id) ?? 1, investorId: r.viewerId, investorName: r.viewerName, opens: 1, firstAt: r.viewedAt, lastAt: r.viewedAt });
    else { g.opens += 1; if (r.viewedAt < g.firstAt) g.firstAt = r.viewedAt; if (r.viewedAt > g.lastAt) g.lastAt = r.viewedAt; }
  }
  return { ok: true, value: { views: [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)), truncated } };
}

export function createInMemoryDocViewStore(names: Record<string, string> = {}) {
  const rows: { id: string; documentId: string; projectId: string; viewerId: string; viewedAt: string }[] = [];
  const store: ProjectDocViewStore = {
    async addView(v, since) {
      if (rows.some(r => r.documentId === v.documentId && r.viewerId === v.viewerId && r.viewedAt >= since)) return false;
      rows.push(v); return true;
    },
    async viewsFor(projectId, limit) {
      return rows.filter(r => r.projectId === projectId).sort((a, b) => b.viewedAt.localeCompare(a.viewedAt)).slice(0, limit)
        .map(r => ({ documentId: r.documentId, viewerId: r.viewerId, viewerName: names[r.viewerId] ?? "Investor", viewedAt: r.viewedAt }));
    }
  };
  return { store, rows };
}
