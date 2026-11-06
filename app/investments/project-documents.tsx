"use client";
import { useEffect, useState } from "react";
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

/** Documents grouped by kind. `showHistory` also lists earlier versions (owner). */
export function DocumentList({ docs, showVisibility, onReplace }: { docs: ProjectDocView[]; showVisibility?: boolean; onReplace?: (d: ProjectDocView) => void }) {
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
              {rows.map(d => (
                <li key={d.id} className={d.current ? "" : "inv-doc-old"}>
                  <div className="inv-doc-main">
                    <a href={`/api/investments/documents/${d.id}`} download>{d.title}</a>
                    <span className="muted inv-small">
                      {d.contentType === "application/pdf" ? "PDF" : "Image"} · {sizeLabel(d.sizeBytes)} · {dateLabel(d.uploadedAt)}
                      {!d.current && " · earlier version"}
                      {showVisibility && ` · ${VISIBILITY_LABEL[d.visibility]}`}
                    </span>
                  </div>
                  {onReplace && d.current && <button type="button" className="secondary" onClick={() => onReplace(d)}>Replace</button>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Read-only section for the project page (owner and investors). */
export function ProjectDocumentsSection({ projectId, mine, editable }: { projectId: string; mine: boolean; editable: boolean }) {
  const { data, error } = useProjectDocuments(projectId);
  return (
    <section className="panel" id="documents">
      <h2>Project documents</h2>
      <p className="muted inv-small">Supplied by the project owner. Not checked or endorsed by the platform.</p>
      {error ? <p role="alert">{error}</p> : !data ? <p className="muted" role="status">Loading…</p> : <DocumentList docs={data.documents.filter(d => d.current)} showVisibility={mine} />}
      {mine && editable && <p><a className="button secondary" href={`/investments/${projectId}/documents`}>Manage documents</a></p>}
    </section>
  );
}
