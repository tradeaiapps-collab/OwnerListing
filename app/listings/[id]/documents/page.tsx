"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "../../../styles/documents.css";

type Doc = { id: string; kind: string; visibility: string; status: string; supersedesId?: string };
type Access = { isOwner: boolean; kinds: string[] };

const KIND_LABELS: Record<string, string> = {
  photo: "Photos", photo_360: "360 photos", video: "Videos", video_360: "360 videos", floorplan: "Floor plans",
  title_search: "Title searches", building_inspection: "Building inspections", pest_report: "Pest reports", contract: "Contracts", other: "Other files"
};
const VISIBILITY_LABELS: Record<string, string> = {
  public: "Public (shown on the published listing)", parties: "Parties only", owner_only: "Owner only"
};

/** Version number of each document, counted along its supersedes chain (earlier versions the viewer cannot see are not counted). */
function versionOf(d: Doc, byId: Map<string, Doc>): number {
  let n = 1;
  for (let p = d.supersedesId ? byId.get(d.supersedesId) : undefined; p; p = p.supersedesId ? byId.get(p.supersedesId) : undefined) n++;
  return n;
}

export default function ListingDocuments() {
  const { id } = useParams<{ id: string }>();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [access, setAccess] = useState<Access>({ isOwner: false, kinds: [] });
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState("");
  const [replace, setReplace] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const r = await fetch(`/api/listings/${id}/documents`, { credentials: "same-origin" });
      const d = await r.json();
      if (r.ok) {
        setDocs(d.documents);
        setAccess(d.canUpload);
      } else setLoadError(r.status === 404 ? "Listing not found." : d.error ?? "Could not load files.");
    } catch {
      setLoadError("Could not load files.");
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const chosenKind = kind || access.kinds[0] || "";
  const replaceable = (docs ?? []).filter(d => d.kind === chosenKind && d.status === "active");

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError("");
    setNotice("");
    const data = new FormData(form);
    if (!replace) data.delete("supersedesId");
    try {
      // No content-type header: the browser sets the multipart boundary.
      const r = await fetch(`/api/listings/${id}/documents`, { method: "POST", body: data, credentials: "same-origin" });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        form.reset();
        setReplace(false);
        setNotice("File added.");
        await load();
      } else setError(r.status === 401 ? "Sign in to add files." : d.error ?? "Could not add the file.");
    } catch {
      setError("Could not add the file.");
    } finally {
      setBusy(false);
    }
  }

  async function requestDeletion(docId: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(`/api/documents/${docId}/deletion-request`, { method: "POST", credentials: "same-origin" });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setNotice(`Request recorded. ${d.reason}`);
      else setError(d.error ?? "Could not record the request.");
    } catch {
      setError("Could not record the request.");
    } finally {
      setBusy(false);
    }
  }

  const back = <p><a href={`/listings/${id}`}>Back to the listing</a></p>;
  if (loadError) return <main>{back}<p role="alert">{loadError}</p></main>;
  if (!docs) return <main>{back}<p className="muted" role="status">Loading...</p></main>;

  const byId = new Map(docs.map(d => [d.id, d]));
  const kinds = Object.keys(KIND_LABELS).filter(k => docs.some(d => d.kind === k));

  return (
    <main>
      {back}
      <h1>Files</h1>
      {access.kinds.length > 0 ? (
        <form className="doc-form" onSubmit={onUpload}>
          <label>File
            <input type="file" name="file" required />
          </label>
          <label>Kind
            <select name="kind" value={chosenKind} onChange={e => setKind(e.target.value)}>
              {access.kinds.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          </label>
          {access.isOwner ? (
            <label>Who can see it
              <select name="visibility" defaultValue="owner_only">
                {Object.entries(VISIBILITY_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
          ) : (
            <input type="hidden" name="visibility" value="parties" />
          )}
          {replaceable.length > 0 && (
            <>
              <label className="inline">
                <input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />
                Replace an earlier version
              </label>
              {replace && (
                <label>Version to replace
                  <select name="supersedesId">
                    {replaceable.map(d => <option key={d.id} value={d.id}>Version {versionOf(d, byId)} ({d.visibility.replace("_", " ")})</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          <button type="submit" disabled={busy}>{busy ? "Uploading..." : "Add file"}</button>
        </form>
      ) : (
        <p className="muted">Only the owner or an approved contractor can add files. Sign in to continue.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {kinds.length === 0 && <p className="muted">No files yet.</p>}
      {kinds.map(k => (
        <section key={k} className="doc-kind" aria-label={KIND_LABELS[k]}>
          <h2>{KIND_LABELS[k]}</h2>
          <ul className="doc-versions">
            {docs.filter(d => d.kind === k).sort((a, b) => versionOf(b, byId) - versionOf(a, byId)).map(d => (
              <li key={d.id} className={`doc-version${d.status === "superseded" ? " superseded" : ""}`}>
                <strong>Version {versionOf(d, byId)}</strong>
                <span>{VISIBILITY_LABELS[d.visibility] ?? d.visibility}</span>
                {d.status === "superseded" && <span className="doc-mark">Superseded (kept on record)</span>}
                {d.status === "held" && <span className="doc-mark">Held (legal record)</span>}
                <a href={`/api/documents/${d.id}/file`}>Download</a>
                {access.isOwner && d.status === "active" && (
                  <button type="button" disabled={busy} onClick={() => void requestDeletion(d.id)}>Request deletion</button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {access.isOwner && <p className="doc-note">Published files cannot be deleted. Use "Replace an earlier version" to amend one; the old version stays on record.</p>}
    </main>
  );
}
