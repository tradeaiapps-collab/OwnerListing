"use client";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { PROJECT_DOC_KIND_LABEL, PROJECT_DOC_KINDS, PROJECT_DOC_MAX_BYTES, PROJECT_DOC_MIMES, type ProjectDocView } from "../../../../src/domain/project-documents";
import { DocumentList, DocumentViewLog, useProjectDocuments, VISIBILITY_LABEL } from "../../project-documents";

/** Owner screen: add project documents (plans, approvals, feasibility studies, contracts, reports), choose who sees each, replace a version. */
export default function ProjectDocuments() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useProjectDocuments(id);
  const [replacing, setReplacing] = useState<ProjectDocView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) { setMsg({ ok: false, text: "Choose a file." }); return; }
    if (!(PROJECT_DOC_MIMES as readonly string[]).includes(file.type)) { setMsg({ ok: false, text: "Only PDF, JPEG, PNG or WebP files." }); return; }
    if (file.size > PROJECT_DOC_MAX_BYTES) { setMsg({ ok: false, text: "Each document must be 50 MB or smaller." }); return; }
    if (replacing) { fd.set("kind", replacing.kind); fd.set("supersedesId", replacing.id); }
    setBusy(true); setMsg(null);
    const r = await fetch(`/api/investments/projects/${id}/documents`, { method: "POST", body: fd }).catch(() => null);
    setBusy(false);
    if (r?.ok) { setMsg({ ok: true, text: "Document added." }); setReplacing(null); form.current?.reset(); reload(); return; }
    const d = r ? await r.json().catch(() => ({})) : {};
    setMsg({ ok: false, text: r?.status === 401 ? "Sign in again to continue." : String((d as { error?: string }).error ?? "Upload failed.") });
  }

  const editable = data?.canManage === true;
  return (
    <main className="inv-detail">
      <p className="inv-back"><a href="/investments/mine">Back to my posted projects</a> · <a href={`/investments/${id}#documents`}>View project</a></p>
      <h1>Project documents</h1>
      <p className="muted">Files are kept on record: a document can be replaced by a new version, never deleted.</p>
      {error && <p role="alert">{error}</p>}
      {editable && (
        <section className="panel" aria-labelledby="add-doc">
          <h2 id="add-doc">{replacing ? `New version of “${replacing.title}”` : "Add a document"}</h2>
          <form ref={form} className="inv-form" onSubmit={submit}>
            <label>Title<input name="title" required minLength={2} maxLength={120} defaultValue={replacing?.title} key={replacing?.id ?? "new"} /></label>
            {!replacing && (
              <label>Kind
                <select name="kind" defaultValue="plan">{PROJECT_DOC_KINDS.map(k => <option key={k} value={k}>{PROJECT_DOC_KIND_LABEL[k]}</option>)}</select>
              </label>
            )}
            <label>Who can see it
              <select name="visibility" defaultValue={replacing?.visibility ?? "private"} key={`v-${replacing?.id ?? "new"}`}>
                {(Object.keys(VISIBILITY_LABEL) as ProjectDocView["visibility"][]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
              </select>
            </label>
            <label>File (PDF, JPEG, PNG or WebP, up to 50 MB)<input name="file" type="file" accept=".pdf,image/jpeg,image/png,image/webp" required /></label>
            <div className="inv-aside-actions">
              <button type="submit" disabled={busy}>{busy ? "Uploading…" : replacing ? "Upload new version" : "Add document"}</button>
              {replacing && <button type="button" className="secondary" onClick={() => setReplacing(null)}>Cancel</button>}
            </div>
            {msg && <p role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
          </form>
        </section>
      )}
      {data && !editable && <p className="muted">This project can no longer be changed.</p>}
      <section className="panel">
        <h2>All documents</h2>
        {!data && !error ? <p className="muted" role="status">Loading…</p> : data && <DocumentList docs={data.documents} showVisibility {...(editable ? { onReplace: setReplacing } : {})} />}
      </section>
      {data?.canManage !== undefined && <DocumentViewLog projectId={id} />}
    </main>
  );
}
