"use client";
import { useEffect, useState } from "react";
import { DocumentViewer } from "./document-viewer";
import { versionNumbers, type ViewSummary } from "../../src/domain/project-document-views";
import { PROJECT_DOC_KIND_LABEL, PROJECT_DOC_KINDS, type ProjectDocList, type ProjectDocView } from "../../src/domain/project-documents";

export const VISIBILITY_LABEL: Record<ProjectDocView["visibility"], string> = { private: "Only you", team: "You and platform reviewers", investors: "Investors who can see this project" };
const sizeLabel = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const dateLabel = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** Loads a project's documents for this viewer. `reload` re-fetches (after an upload). */
export function useProjectDocuments(projectId: string) {
  const [data, setData] = useState<ProjectDocList | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    void fetch(`/api/investments/projects/${projectId}/documents`).then(async r => {
      if (r.ok) { setData(await r.json()); setError(""); } else setError("Documents could not be loaded.");
    }).catch(() => setError("Documents could not be loaded."));
  }, [projectId, tick]);
  return { data, error, reload: () => setTick(t => t + 1) };
}

/** Earlier versions of `d`, newest first (the owner's list includes them; an investor's does not). */
function chainOf(d: ProjectDocView, all: ProjectDocView[]): ProjectDocView[] {
  const byId = new Map(all.map(x => [x.id, x]));
  const out: ProjectDocView[] = [];
  for (let p = d.supersedesId ? byId.get(d.supersedesId) : undefined; p && out.length < 200; p = p.supersedesId ? byId.get(p.supersedesId) : undefined) out.push(p);
  return out;
}

const MASKING_LABEL: Record<ProjectDocView["masking"], string> = { not_needed: "", pending: " · waiting for address masking review", confirmed: " · address masking confirmed" };

/**
 * Documents grouped by kind. Each opens in the in-site viewer (no download link); only the owner can also download the original.
 * `showVisibility` also shows who can see each (owner).
 */
export function DocumentList({ docs, showVisibility, onReplace }: { docs: ProjectDocView[]; showVisibility?: boolean; onReplace?: (d: ProjectDocView) => void }) {
  const [open, setOpen] = useState<ProjectDocView | null>(null);
  const versions = versionNumbers(docs);
  if (docs.length === 0) return <p className="muted" role="status">No documents have been added yet.</p>;
  return (
    <div className="inv-docs">
      {PROJECT_DOC_KINDS.map(kind => {
        const rows = docs.filter(d => d.kind === kind);
        if (rows.length === 0) return null;
        return (
          <section key={kind} aria-label={PROJECT_DOC_KIND_LABEL[kind]}>
            <h3>{PROJECT_DOC_KIND_LABEL[kind]}</h3>
            <ul>
              {rows.filter(d => d.current).map(d => {
                const history = chainOf(d, rows);
                return (
                  <li key={d.id}>
                    <div className="inv-doc-main">
                      <button type="button" className="inv-doc-open" onClick={() => setOpen(d)} aria-haspopup="dialog">{d.title}</button>
                      <span className="muted inv-small">
                        {versions.get(d.id) ? `Version ${versions.get(d.id)} · ` : ""}{d.contentType === "application/pdf" ? "PDF" : "Image"} · {sizeLabel(d.sizeBytes)} · {dateLabel(d.uploadedAt)}
                        {showVisibility && ` · ${VISIBILITY_LABEL[d.visibility]}`}
                        {showVisibility && MASKING_LABEL[d.masking]}
                      </span>
                    </div>
                    <div className="inv-doc-actions">
                      {showVisibility && <a className="button secondary" href={`/api/investments/documents/${d.id}`} download>Download original</a>}
                      {onReplace && <button type="button" className="secondary" onClick={() => onReplace(d)}>Upload new version</button>}
                    </div>
                    {history.length > 0 && (
                      <details className="inv-doc-history">
                        <summary>Version history ({history.length + 1} versions)</summary>
                        <ul>
                          {history.map(h => (
                            <li key={h.id} className="inv-doc-old">
                              <span className="inv-doc-main">
                                <button type="button" className="inv-doc-open" onClick={() => setOpen(h)} aria-haspopup="dialog">Version {versions.get(h.id)} · {h.title}</button>
                                <span className="muted inv-small">{sizeLabel(h.sizeBytes)} · {dateLabel(h.uploadedAt)} · replaced</span>
                              </span>
                              {showVisibility && <a className="button secondary" href={`/api/investments/documents/${h.id}`} download>Download original</a>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {open && <DocumentViewer docId={open.id} title={open.title} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Read-only section for the project page (owner and investors). */
export function ProjectDocumentsSection({ projectId, mine, editable }: { projectId: string; mine: boolean; editable: boolean }) {
  const { data, error } = useProjectDocuments(projectId);
  return (
    <section className="panel" id="documents">
      <h2>Project documents</h2>
      <p className="muted inv-small">Supplied by the project owner. Not checked or endorsed by the platform. {mine ? "Investors read these pages in the site, with the project address hidden, once reviewers have confirmed the masking." : "Documents open in the site and cannot be downloaded. The project address is hidden. The project owner can see which investors opened a document and when."}</p>
      {error ? <p role="alert">{error}</p> : !data ? <p className="muted" role="status">Loading…</p> : <DocumentList docs={data.documents.filter(d => d.current)} showVisibility={mine} />}
      {mine && editable && <p><a className="button secondary" href={`/investments/${projectId}/documents`}>Manage documents</a></p>}
    </section>
  );
}

const dateTimeLabel = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Owner only: which investors opened which document, and when. */
export function DocumentViewLog({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ views: ViewSummary[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch(`/api/investments/projects/${projectId}/documents/views`).then(async r => {
      if (r.ok) setData(await r.json()); else setError("The view log could not be loaded.");
    }).catch(() => setError("The view log could not be loaded."));
  }, [projectId]);
  return (
    <section className="panel" aria-labelledby="view-log">
      <h2 id="view-log">Who opened your documents</h2>
      <p className="muted inv-small">Each time an investor opens a document in the site it is recorded. Opening the same document again within 10 minutes counts once. Investors are told this on the project page.</p>
      {error ? <p role="alert">{error}</p> : !data ? <p className="muted" role="status">Loading…</p> : data.views.length === 0 ? <p className="muted" role="status">No investor has opened a document yet.</p> : (
        <ul className="inv-views">
          {data.views.map(v => (
            <li key={`${v.documentId}:${v.investorId}`}>
              <div className="inv-doc-main">
                <strong>{v.investorName}</strong>
                <span className="muted inv-small">{v.title} · version {v.version}</span>
              </div>
              <div className="inv-view-meta muted inv-small">
                <span>{v.opens} {v.opens === 1 ? "open" : "opens"}</span>
                <span>Last: {dateTimeLabel(v.lastAt)}</span>
                {v.opens > 1 && <span>First: {dateTimeLabel(v.firstAt)}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data?.truncated && <p className="muted inv-small">Showing the most recent activity only.</p>}
    </section>
  );
}
