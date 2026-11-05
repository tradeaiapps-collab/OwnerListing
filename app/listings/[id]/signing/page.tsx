"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Breadcrumbs from "../../../breadcrumbs";
import { STATUS_LABEL } from "../../../signing/labels";
import { JSON_HEADERS } from "../../ui";
import "../../../styles/signing.css";

type Field = { key: string; label: string; type: "text" | "multiline" | "date" | "money"; required: boolean };
type Template = { key: string; title: string; category: string; version: number; fields: Field[] };
type Doc = { id: string; title: string; status: string; createdAt: string; signers: { id: string; roleLabel: string; status: string }[] };
type SignerInput = { email: string; roleLabel: string };

/** Owner: generate a document from a published template, add who signs, read it, then send it for signature. */
export default function ListingDocuments() {
  const { id } = useParams<{ id: string }>();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [key, setKey] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [signers, setSigners] = useState<SignerInput[]>([{ email: "", roleLabel: "" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, d] = await Promise.all([fetch("/api/doc-templates"), fetch(`/api/listings/${id}/signing-documents`)]);
      if (t.ok && d.ok) { setTemplates((await t.json()).templates); setDocs((await d.json()).documents); }
      else setLoadError(t.status === 401 || d.status === 401 ? "Sign in to manage documents." : d.status === 404 ? "Listing not found." : "Could not load documents.");
    } catch { setLoadError("Could not load documents."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const tpl = templates?.find(t => t.key === key);
  const setSigner = (i: number, patch: Partial<SignerInput>) => setSigners(s => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function onGenerate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/listings/${id}/signing-documents`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ templateKey: key, values, signers }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) window.location.assign(`/signing/${d.document.id}`);
      else setError(d.error ?? "Could not create the document.");
    } catch { setError("Could not create the document."); } finally { setBusy(false); }
  }

  return (
    <main>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "My listings", href: "/listings/mine" }, { label: "Documents and e-signatures" }]} />
      <h1>Documents and e-signatures</h1>
      <p className="muted">Create an agreement or declaration from an approved template, read it, then send it for signature. Everyone who signs needs an account on the platform. The wording is general information, not legal advice. Ask your solicitor about anything that matters.</p>
      {loadError && <p role="alert">{loadError}</p>}
      {!loadError && (templates === null || docs === null) && <p className="muted" role="status">Loading…</p>}

      {templates && docs && (
        <>
          <h2>This listing's documents</h2>
          {docs.length === 0 ? <p className="empty">No documents yet.</p> : (
            <ul className="card-list">
              {docs.map(d => (
                <li key={d.id}>
                  <strong><a href={`/signing/${d.id}`}>{d.title}</a></strong>
                  <span><span className={`sg-badge is-${d.status}`}>{STATUS_LABEL[d.status] ?? d.status}</span></span>
                  <small className="muted">{d.signers.filter(s => s.status === "signed").length} of {d.signers.length} signed · {new Date(d.createdAt).toLocaleDateString("en-AU")}</small>
                </li>
              ))}
            </ul>
          )}

          <h2>Create a document</h2>
          {templates.length === 0 ? <p className="empty">No templates are available yet. They appear here once our team has reviewed and published them.</p> : (
            <form className="stack" onSubmit={onGenerate}>
              <label>Template
                <select value={key} onChange={e => { setKey(e.target.value); setValues({}); }} required>
                  <option value="">Choose a template…</option>
                  {templates.map(t => <option key={t.key} value={t.key}>{t.title}</option>)}
                </select>
              </label>
              {tpl?.fields.map(f => (
                <label key={f.key}>{f.label}{f.required ? "" : " (optional)"}
                  {f.type === "multiline"
                    ? <textarea rows={3} maxLength={1000} value={values[f.key] ?? ""} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} required={f.required} />
                    : <input type={f.type === "date" ? "date" : "text"} inputMode={f.type === "money" ? "decimal" : undefined} placeholder={f.type === "money" ? "650000" : undefined}
                        maxLength={200} value={values[f.key] ?? ""} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} required={f.required} />}
                </label>
              ))}
              {tpl && (
                <fieldset className="stack">
                  <legend>Who signs</legend>
                  {signers.map((s, i) => (
                    <div className="sg-row" key={i}>
                      <label>Email on their account<input type="email" value={s.email} onChange={e => setSigner(i, { email: e.target.value })} required maxLength={320} /></label>
                      <label>Role (for example Agent or Buyer)<input value={s.roleLabel} onChange={e => setSigner(i, { roleLabel: e.target.value })} required minLength={2} maxLength={60} /></label>
                      {signers.length > 1 && <button type="button" className="secondary" onClick={() => setSigners(x => x.filter((_, j) => j !== i))}>Remove</button>}
                    </div>
                  ))}
                  {signers.length < 6 && <div><button type="button" className="secondary" onClick={() => setSigners(x => [...x, { email: "", roleLabel: "" }])}>Add another signer</button></div>}
                </fieldset>
              )}
              {tpl && <div><button type="submit" disabled={busy}>{busy ? "Creating…" : "Create and review"}</button></div>}
              {error && <p role="alert">{error}</p>}
            </form>
          )}
        </>
      )}
    </main>
  );
}
