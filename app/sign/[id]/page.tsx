"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JSON_HEADERS } from "../../listings/ui";
import "../../styles/transaction.css";

type Signer = { name: string; roleLabel: string; status: string; signedAt: string | null; typedName: string | null; evidenceSha256: string | null };
type Detail = {
  consent: { version: string; text: string };
  document: { id: string; listingId: string; title: string; body: string; version: number; latest: boolean; contentSha256: string };
  requests: { id: string; status: string; expiresAt: string; mine: { status: string; roleLabel: string } | null; signers: Signer[] }[];
};
const stamp = (iso: string) => new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export default function SignPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(async () => {
    const a = await fetch(`/api/signature-requests/${id}`).catch(() => null);
    const ad = a ? await a.json().catch(() => ({})) : {};
    if (!a?.ok) { setLoadError(!a ? "Could not load the document." : a.status === 401 ? "Sign in to read and sign this document." : "This document was not found."); return; }
    const r = await fetch(`/api/generated-documents/${ad.request.documentId}`).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) setDetail(d); else setLoadError("This document was not found.");
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const rq = detail?.requests.find(x => x.id === id);
  const mine = rq?.mine;
  const open = rq?.status === "pending" && mine?.status === "pending" && detail?.document.latest;

  async function submit(action: "sign" | "decline") {
    if (!detail) return;
    setBusy(true); setError("");
    const body = action === "sign" ? { action, typedName: name, consent, consentVersion: detail.consent.version } : { action, reason: reason.trim() || undefined };
    const r = await fetch(`/api/signature-requests/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (r?.ok) { setDone(action === "sign" ? (d.status === "completed" ? "You signed. Everyone has now signed this document." : "You signed. We'll tell the owner and wait for the others.") : "You declined to sign. The owner has been told."); await load(); }
    else setError(d.error ?? "Could not record your answer.");
  }

  return (
    <main>
      <h1>{detail?.document.title ?? "Sign a document"}</h1>
      {loadError ? <><p role="alert" className="tx-err">{loadError}</p>{loadError.startsWith("Sign in") ? <p><a className="button" href={`/login?next=/sign/${id}`}>Sign in</a></p> : null}</> : null}
      {!loadError && !detail ? <p className="muted" role="status">Loading…</p> : null}
      {detail && rq && (
        <div className="tx-main">
          <p className="tx-meta"><span className={`badge badge-${rq.status}`}>{rq.status === "pending" ? "Waiting for signatures" : rq.status}</span><span>Version {detail.document.version}</span><span>Expires {stamp(rq.expiresAt)}</span></p>
          {!detail.document.latest && <p className="notice"><strong>This version has been replaced.</strong>Ask the owner for the new one.</p>}
          <section aria-labelledby="doc-title" className="panel">
            <h2 id="doc-title">Read the whole document</h2>
            <pre className="tx-doc-body" tabIndex={0} aria-label="Document text">{detail.document.body}</pre>
            <p className="tx-hash">Fingerprint (SHA-256): {detail.document.contentSha256}</p>
          </section>

          {done ? <p role="status" className="tx-ok">{done}</p> : null}
          {error ? <p role="alert" className="tx-err">{error}</p> : null}

          {open && !declining && (
            <section aria-labelledby="sign-title" className="panel">
              <h2 id="sign-title">Sign as {mine?.roleLabel}</h2>
              <form className="tx-form" onSubmit={e => { e.preventDefault(); void submit("sign"); }}>
                <label className="tx-consent"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /><span>{detail.consent.text}</span></label>
                <label>Your full name<input value={name} onChange={e => setName(e.target.value)} maxLength={120} autoComplete="name" /><span className="tx-hint">Typing your name here is your signature.</span></label>
                <div className="actions">
                  <button type="submit" disabled={busy || !consent || name.trim().length < 3}>{busy ? "Signing…" : "Sign document"}</button>
                  <button type="button" className="secondary" onClick={() => setDeclining(true)}>Decline</button>
                </div>
                <p className="muted"><small>Your answer is final once given. We keep the document fingerprint, your typed name, the time and the consent wording as the record. This is general information, not legal advice; ask your solicitor if unsure.</small></p>
              </form>
            </section>
          )}
          {open && declining && (
            <section className="panel" aria-labelledby="decline-title">
              <h2 id="decline-title">Decline to sign</h2>
              <div className="tx-form">
                <label>Reason (optional)<input value={reason} maxLength={300} onChange={e => setReason(e.target.value)} /></label>
                <div className="actions"><button type="button" className="danger" disabled={busy} onClick={() => void submit("decline")}>Decline</button><button type="button" className="secondary" onClick={() => setDeclining(false)}>Go back</button></div>
              </div>
            </section>
          )}

          <section aria-labelledby="who-title">
            <h2 id="who-title">Signatures</h2>
            <ul className="card-list">
              {rq.signers.map((s, n) => (
                <li key={n}>
                  <div className="tx-head"><h3>{s.name} · {s.roleLabel}</h3><span className={`badge badge-${s.status}`}>{s.status}</span></div>
                  {s.status === "signed" && <p className="tx-meta"><span>Signed as “{s.typedName}”</span><span>{s.signedAt ? stamp(s.signedAt) : ""}</span></p>}
                  {s.evidenceSha256 && <p className="tx-hash">Record: {s.evidenceSha256}</p>}
                </li>
              ))}
            </ul>
          </section>
          <p><a href="/dashboard">Back to dashboard</a></p>
        </div>
      )}
    </main>
  );
}
