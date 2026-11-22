"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../ui";
import TxnAssistant from "../txn-assistant";
import "../../../styles/transaction.css";

type Field = { key: string; label: string; required: boolean; maxLength: number; multiline: boolean; value: string };
type Template = { id: string; title: string; summary: string; signerRoles: string[]; fields: Field[] };
type Signer = { name: string; roleLabel: string; status: string };
type Doc = { id: string; title: string; templateId: string; version: number; createdAt: string; latest: boolean; mine: boolean; state: string; openRequestId: string | null; signers: Signer[]; signerRoles: string[] };
type Req = { key: string; label: string; why: string; priority: string; done: boolean; href: string };
type Party = { userId: string; name: string; role: string };
type Event = { at: string; type: string; actorName?: string; version: number };
type Detail = { document: { body: string; fields?: Record<string, string> }; requests: { id: string; status: string; signers: (Signer & { signedAt: string | null; typedName: string | null })[] }[] };
type History = { versions: { id: string; version: number; createdAt: string; createdByName: string; contentSha256: string }[]; events: Event[] };

const STATE: Record<string, string> = { draft: "Draft", awaiting_signature: "Out for signing", signed: "Signed", declined: "Declined" };
const EVENT: Record<string, string> = { created: "Created", version_created: "New version", viewed: "Opened by a signer", sign_requested: "Sent for signing", signed: "Signed", declined: "Declined", cancelled: "Request cancelled", completed: "Everyone has signed", expired: "Request expired" };
const stamp = (iso: string) => new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export default function TransactionPage() {
  const { id } = useParams<{ id: string }>();
  const [role, setRole] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [label, setLabel] = useState("");
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [owner, setOwner] = useState<{ id: string } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);
  const [tpl, setTpl] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; detail?: Detail; history?: History } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const handler = role === "owner" || role === "agent";
  const load = useCallback(async () => {
    setLoadError("");
    const get = async (u: string) => { const r = await fetch(u, { credentials: "same-origin" }).catch(() => null); return { r, d: r ? await r.json().catch(() => ({})) : {} }; };
    const list = await get(`/api/listings/${id}/generated-documents`);
    if (!list.r?.ok) { setLoadError(!list.r ? "Could not load documents." : list.r.status === 401 ? "Sign in to see documents." : list.r.status === 404 ? "Listing not found." : list.d.error ?? "Could not load documents."); return; }
    setRole(list.d.role); setDocs(list.d.documents);
    if (list.d.role === "owner" || list.d.role === "agent") {
      const [t, a, i] = await Promise.all([get(`/api/listings/${id}/document-templates`), get(`/api/listings/${id}/transaction-assistant`), get(`/api/listings/${id}/inspections`)]);
      if (t.r?.ok) { setTemplates(t.d.templates); setLabel(t.d.label); }
      if (a.r?.ok) setReqs(a.d.requirements);
      if (i.r?.ok) setParties(i.d.parties);
    }
    const me = await get("/api/auth/me");
    setOwner(me.d?.user?.id ? { id: me.d.user.id } : null);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const chosen = templates.find(t => t.id === tpl);
  const pickTemplate = (tid: string) => {
    setTpl(tid); setReplacing(null); setFieldErrors({}); setError("");
    const t = templates.find(x => x.id === tid);
    setValues(Object.fromEntries((t?.fields ?? []).map(f => [f.key, f.value])));
  };

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    const r = await fetch(`/api/listings/${id}/document-templates`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ templateId: chosen.id, fields: values, ...(replacing ? { supersedesId: replacing } : {}) }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { setNotice(replacing ? `Version ${d.document.version} saved. The earlier version is kept in the history.` : "Document created. Next, send it for signing if it needs signatures."); setTpl(""); setReplacing(null); await load(); setBump(b => b + 1); }
    else { setError(d.error ?? "Could not make the document."); setFieldErrors(d.fields ?? {}); }
  }

  async function show(doc: Doc, what: "read" | "history") {
    if (open?.id === doc.id && ((what === "read" && open.detail) || (what === "history" && open.history))) { setOpen(null); return; }
    const url = what === "read" ? `/api/generated-documents/${doc.id}` : `/api/generated-documents/${doc.id}/history`;
    const r = await fetch(url).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) setOpen(what === "read" ? { id: doc.id, detail: d } : { id: doc.id, history: d }); else setError(d.error ?? "Could not open the document.");
  }

  async function newVersion(doc: Doc) {
    const r = await fetch(`/api/generated-documents/${doc.id}`).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok || !d.document?.fields) { setError("Could not load the document to change."); return; }
    setTpl(doc.templateId); setReplacing(doc.id); setValues(d.document.fields); setFieldErrors({}); setError("");
    setTimeout(() => document.getElementById("tx-make")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function sendForSigning(doc: Doc) {
    const signers = Object.entries(picked).filter(([, label]) => label.trim()).map(([userId, roleLabel]) => ({ userId, roleLabel: roleLabel.trim() }));
    setBusy(true); setError(""); setNotice("");
    const r = await fetch(`/api/generated-documents/${doc.id}/signature-requests`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ signers }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { setNotice("Sent. Each signer gets an email and sees it on their dashboard."); setSending(null); setPicked({}); await load(); setBump(b => b + 1); } else setError(d.error ?? "Could not send it for signing.");
  }

  async function cancel(requestId: string) {
    setBusy(true); setError("");
    const r = await fetch(`/api/signature-requests/${requestId}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action: "cancel" }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { setNotice("Request cancelled."); setOpen(null); await load(); } else setError(d.error ?? "Could not cancel.");
  }

  function startSending(doc: Doc) {
    setSending(doc.id);
    setPicked(owner && doc.signerRoles.includes("Owner") ? { [owner.id]: "Owner" } : {});
  }

  const candidates = [...(owner ? [{ userId: owner.id, name: "You (owner)", role: "owner" }] : []), ...parties.filter(p => p.role === "buyer")];

  return (
    <main>
      <h1>Documents and signing</h1>
      <p className="muted">Make documents from templates, keep every version, and collect electronic signatures. {label}</p>
      {loadError ? <p role="alert" className="tx-err">{loadError}</p> : null}
      {!loadError && docs === null ? <p className="muted" role="status">Loading…</p> : null}
      {docs && (
        <div className="tx-layout">
          <div className="tx-main">
            {error ? <p role="alert" className="tx-err">{error}</p> : null}
            {notice ? <p role="status" className="tx-ok">{notice}</p> : null}

            {handler && reqs.length > 0 && (
              <section aria-labelledby="need-title" className="panel">
                <h2 id="need-title">What this stage needs</h2>
                <ul className="tx-req">
                  {reqs.map(r => (
                    <li key={r.key} className={r.done ? "done" : ""}>
                      <span className="tx-dot" aria-hidden="true">{r.done ? "✓" : ""}</span>
                      <span><strong>{r.label}</strong> <span className={`badge ${r.done ? "badge-completed" : "badge-requested"}`}>{r.done ? "Done" : r.priority === "required" ? "Required" : "Recommended"}</span></span>
                      {!r.done && <span className="tx-why">{r.why} <a href={`/listings/${id}/${r.href === "documents" ? "documents" : r.href === "inspections" ? "inspections" : "transaction"}`}>Go</a></span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {handler && (
              <section aria-labelledby="make-title" className="panel" id="tx-make">
                <h2 id="make-title">{replacing ? "Change a document (new version)" : "Make a document"}</h2>
                {!replacing && (
                  <label className="tx-form">Template
                    <select value={tpl} onChange={e => pickTemplate(e.target.value)}>
                      <option value="">Choose a template…</option>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </select>
                  </label>
                )}
                {chosen && (
                  <form className="tx-form" onSubmit={create} noValidate>
                    <p className="muted">{chosen.summary}</p>
                    {chosen.fields.map(f => (
                      <label key={f.key}>{f.label}{f.required ? "" : " (optional)"}
                        {f.multiline
                          ? <textarea value={values[f.key] ?? ""} maxLength={f.maxLength} aria-invalid={fieldErrors[f.key] ? true : undefined} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} />
                          : <input value={values[f.key] ?? ""} maxLength={f.maxLength} aria-invalid={fieldErrors[f.key] ? true : undefined} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} />}
                        {fieldErrors[f.key] ? <span className="field-error">{fieldErrors[f.key]}</span> : null}
                      </label>
                    ))}
                    <div className="actions">
                      <button type="submit" disabled={busy}>{busy ? "Saving…" : replacing ? "Save as new version" : "Create document"}</button>
                      <button type="button" className="secondary" onClick={() => { setTpl(""); setReplacing(null); }}>Cancel</button>
                    </div>
                  </form>
                )}
              </section>
            )}

            <section aria-labelledby="docs-title">
              <h2 id="docs-title">{handler ? "Documents" : "Documents for you to sign"}</h2>
              {docs.length === 0 ? <p className="empty">{handler ? "No documents yet. Choose a template above." : "Nothing here yet."}</p> : (
                <ul className="card-list">
                  {docs.map(d => (
                    <li key={d.id}>
                      <div className="tx-head">
                        <h3>{d.title}</h3>
                        <span className={`badge badge-${d.state}`}>{STATE[d.state] ?? d.state}</span>
                      </div>
                      <p className="tx-meta"><span>Version {d.version}{d.latest ? "" : " (replaced)"}</span><span>{stamp(d.createdAt)}</span></p>
                      {d.signers.length > 0 && <ul className="tx-signers" aria-label="Signers">{d.signers.map((s, n) => <li key={n}><span className={`badge badge-${s.status}`}>{s.name} · {s.roleLabel} · {s.status}</span></li>)}</ul>}
                      <div className="actions">
                        {d.openRequestId && <a className="button" href={`/sign/${d.openRequestId}`}>Read and sign</a>}
                        <button type="button" className="secondary" onClick={() => void show(d, "read")}>{open?.id === d.id && open.detail ? "Hide" : "Read"}</button>
                        <button type="button" className="secondary" onClick={() => void show(d, "history")}>{open?.id === d.id && open.history ? "Hide history" : "History"}</button>
                        {handler && d.latest && <button type="button" className="secondary" onClick={() => void newVersion(d)}>New version</button>}
                        {role === "owner" && d.latest && d.state !== "awaiting_signature" && d.state !== "signed" && <button type="button" onClick={() => startSending(d)}>Send for signing</button>}
                      </div>
                      {sending === d.id && (
                        <fieldset className="tx-form">
                          <legend>Who needs to sign?</legend>
                          {candidates.map(c => (
                            <div key={c.userId} className="tx-row">
                              <label className="tx-consent"><input type="checkbox" checked={c.userId in picked} onChange={e => setPicked(p => { const n = { ...p }; if (e.target.checked) n[c.userId] = c.role === "owner" ? "Owner" : "Buyer"; else delete n[c.userId]; return n; })} />{c.name}</label>
                              {c.userId in picked && <label>Role<input value={picked[c.userId]} maxLength={40} onChange={e => setPicked(p => ({ ...p, [c.userId]: e.target.value }))} /></label>}
                            </div>
                          ))}
                          {candidates.length === 1 && <p className="muted">Buyers appear here once they have enquired on the listing.</p>}
                          <p className="muted"><small>Signers can read the document first and sign or decline. The request expires after 14 days.</small></p>
                          <div className="actions"><button type="button" disabled={busy || Object.keys(picked).length === 0} onClick={() => void sendForSigning(d)}>Send</button><button type="button" className="secondary" onClick={() => setSending(null)}>Cancel</button></div>
                        </fieldset>
                      )}
                      {open?.id === d.id && open.detail && (
                        <div>
                          <pre className="tx-doc-body" tabIndex={0} aria-label={`${d.title} text`}>{open.detail.document.body}</pre>
                          {open.detail.requests.map(rq => (
                            <p key={rq.id} className="tx-meta"><span className={`badge badge-${rq.status}`}>Request: {rq.status}</span>
                              {role === "owner" && rq.status === "pending" && <button type="button" className="secondary" disabled={busy} onClick={() => void cancel(rq.id)}>Cancel this request</button>}</p>
                          ))}
                        </div>
                      )}
                      {open?.id === d.id && open.history && (
                        <div>
                          <h4>History</h4>
                          <ol className="tx-timeline">
                            {open.history.events.map((ev, n) => (
                              <li key={n}><span><strong>{EVENT[ev.type] ?? ev.type}</strong>{ev.actorName ? ` · ${ev.actorName}` : ""} · version {ev.version}</span><time dateTime={ev.at}>{stamp(ev.at)}</time></li>
                            ))}
                          </ol>
                          <p className="tx-hash">Fingerprints: {open.history.versions.map(v => `v${v.version} ${v.contentSha256.slice(0, 12)}`).join(" · ")}</p>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <p><a href={`/listings/${id}/inspections`}>Inspections</a> · <a href={`/listings/${id}/documents`}>Uploaded files</a></p>
          </div>
          <aside className="tx-aside"><TxnAssistant listingId={id} refreshKey={bump} /></aside>
        </div>
      )}
    </main>
  );
}
