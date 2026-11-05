"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { ChatPersona } from "../../../src/domain/chat-assistant";
import Breadcrumbs from "../../breadcrumbs";
import { ElenaStage, speak, type StageState } from "../../enquiries/elena-stage";
import { JSON_HEADERS } from "../../listings/ui";
import { EVENT_LABEL, STATUS_LABEL } from "../labels";
import "../../styles/enquiries.css";
import "../../styles/signing.css";

type Signer = { id: string; userId: string; displayName: string; roleLabel: string; status: "pending" | "signed" | "declined"; signedAt?: string };
type Clause = { id: string; heading: string; text: string };
type Doc = { id: string; listingId: string; listingTitle: string; title: string; status: string; bodySha256: string; provider: "builtin" | "docusign"; clauses: Clause[]; signers: Signer[]; createdAt: string };
type Artifact = { id: string; kind: "signed_pdf" | "certificate"; sha256: string; sizeBytes: number; createdAt: string };
type Ev = { id: number; actorName: string; eventType: string; ip?: string; detail: Record<string, unknown>; occurredAt: string };
type View = { mfaFresh?: boolean; document: Doc; viewer: { role: "owner" | "signer"; canSign: boolean }; events: Ev[]; artifacts?: Artifact[]; persona: ChatPersona };
type Explained = { heading: string; explanation: string; disclaimer: string };

/**
 * One document: the text, who has signed, and the audit trail. Signers read it, can ask the assistant to explain any clause in plain
 * English (approved text written with the template, never invented), then type their name and agree to sign. The assistant never signs.
 */
export default function SigningPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<View | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [explained, setExplained] = useState<Record<string, Explained>>({});
  const [current, setCurrent] = useState<string | null>(null);
  const [walk, setWalk] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voice, setVoice] = useState(true);
  const [typedName, setTypedName] = useState("");
  const [consent, setConsent] = useState(false);
  const [reason, setReason] = useState("");
  const [returning, setReturning] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/signing-documents/${id}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) setView(d);
      else setLoadError(r.status === 401 ? "Sign in to open this document." : r.status === 404 ? "Document not found." : "Could not load the document.");
    } catch { setLoadError("Could not load the document."); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  // Back from DocuSign: ask for the latest status once, in case the webhook has not arrived yet, then show the page as it stands.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("docusign") !== "return") return;
    setReturning(true);
    void (async () => { try { await post({ action: "refresh" }); } catch { /* the webhook will catch up */ } await load(); setReturning(false); })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The floating guide is the same character; on this page she is already on stage, so the launcher steps aside.
  useEffect(() => { document.body.classList.add("el-chat-page"); return () => document.body.classList.remove("el-chat-page"); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; window.speechSynthesis?.cancel(); }; }, []);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(`/api/signing-documents/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
    return { ok: r.ok, data: await r.json().catch(() => ({})) as Record<string, unknown> };
  };

  async function explain(c: Clause) {
    setError(""); setCurrent(c.id);
    const r = await post({ action: "explain", clauseId: c.id }).catch(() => null);
    if (!r?.ok) { setError((r?.data["error"] as string) ?? "Could not get an explanation."); return; }
    const e = r.data as unknown as Explained;
    setExplained(x => ({ ...x, [c.id]: e }));
    if (voice) { setSpeaking(true); if (!speak(`${c.heading}. ${e.explanation}`, () => alive.current && setSpeaking(false))) setSpeaking(false); }
  }
  async function act(body: Record<string, unknown>, failMessage: string) {
    setBusy(true); setError("");
    try {
      const r = await post(body);
      if (r.ok) { setConsent(false); setReason(""); await load(); }
      else if (r.data["code"] === "mfa_required") window.location.assign(`/mfa?next=${encodeURIComponent(`/signing/${id}`)}`);
      else setError((r.data["error"] as string) ?? failMessage);
    } catch { setError(failMessage); } finally { setBusy(false); }
  }
  async function openDocusign() {
    setBusy(true); setError("");
    try {
      const r = await post({ action: "docusign_link" });
      if (r.ok && typeof r.data["url"] === "string") { window.location.assign(r.data["url"]); return; }
      if (r.data["code"] === "mfa_required") { window.location.assign(`/mfa?next=${encodeURIComponent(`/signing/${id}`)}`); return; }
      setError((r.data["error"] as string) ?? "Could not open DocuSign.");
    } catch { setError("Could not open DocuSign."); }
    setBusy(false);
  }
  async function retry() {
    setBusy(true); setError("");
    try {
      const r = await post({ action: "retry" });
      const next = (r.data["document"] as { id?: string } | undefined)?.id;
      if (r.ok && next) { window.location.assign(`/signing/${next}`); return; }
      setError((r.data["error"] as string) ?? "Could not send this again.");
    } catch { setError("Could not send this again."); }
    setBusy(false);
  }
  const walkTo = (i: number) => { const c = view?.document.clauses[i]; if (c) void explain(c); else { setWalk(false); setCurrent(null); } };

  if (loadError) return <main><h1>Document</h1><p role="alert">{loadError}</p></main>;
  if (!view) return <main><h1>Document</h1><p className="muted" role="status">Loading…</p></main>;
  const { document: d, viewer, events, persona } = view;
  const artifacts = view.artifacts ?? [];
  const viaDocusign = d.provider === "docusign";
  const idx = d.clauses.findIndex(c => c.id === current);
  const stage: StageState = speaking ? { pose: "tablet", status: "explaining", pointing: false, mood: "explain" }
    : current ? { pose: "tablet", status: "presenting", pointing: false } : { pose: "front", status: "welcome", pointing: false };

  return (
    <main>
      <Breadcrumbs trail={[{ label: "Home", href: "/" }, { label: "Documents", href: "/signing" }, { label: d.title }]} />
      <div className="sg-head">
        <h1>{d.title}</h1>
        <span className={`sg-badge is-${d.status}`}>{STATUS_LABEL[d.status] ?? d.status}</span>
      </div>
      <p className="muted"><a href={`/listings/${d.listingId}`}>{d.listingTitle}</a>. Fingerprint of this exact text (SHA-256): <span className="sg-hash">{d.bodySha256}</span></p>
      <div className="el-layout has-stage">
        <ElenaStage persona={persona} state={stage} speaking={speaking} voice={voice} onVoice={setVoice} turnKey={current ?? "welcome"} turnWords={current ? (explained[current]?.explanation ?? "").split(/\s+/).length : 0} />
        <div className="el-chat">
          <section className="sg-sign" aria-label={`${persona.name}, your guide`}>
            <p>{persona.name} is an AI assistant. She can explain any clause below in plain English and walk you through the document. She cannot sign for you, change the text or give legal advice, so ask a solicitor if you are unsure.</p>
            <div className="sg-actions">
              <button type="button" onClick={() => { setWalk(true); walkTo(0); }} disabled={busy || d.clauses.length === 0}>Walk me through it</button>
              {walk && <button type="button" className="secondary" onClick={() => walkTo(idx + 1)} disabled={busy}>{idx + 1 < d.clauses.length ? "Next clause" : "Finish"}</button>}
              {walk && idx > 0 && <button type="button" className="secondary" onClick={() => walkTo(idx - 1)} disabled={busy}>Previous clause</button>}
            </div>
          </section>
          <div className="sg-clauses">
            {d.clauses.map((c, i) => (
              <article key={c.id} className={`sg-clause${current === c.id ? " is-current" : ""}`} aria-labelledby={`c-${c.id}`}>
                <h3 id={`c-${c.id}`}>{i + 1}. {c.heading}</h3>
                <p className="pre">{c.text}</p>
                {explained[c.id] && (
                  <div className="sg-explain" role="note">
                    <p>{explained[c.id]!.explanation}</p>
                    <small>{explained[c.id]!.disclaimer}</small>
                  </div>
                )}
                <div className="sg-actions"><button type="button" className="secondary" onClick={() => void explain(c)} disabled={busy}>Explain this clause</button></div>
              </article>
            ))}
          </div>

          <h2>Signers</h2>
          <ul className="sg-signers">
            {d.signers.map(s => (
              <li key={s.id}><span>{s.displayName} · {s.roleLabel}</span><span className="muted">{s.status === "signed" && s.signedAt ? `Signed ${new Date(s.signedAt).toLocaleString("en-AU")}` : s.status === "declined" ? "Declined" : "Waiting"}</span></li>
            ))}
          </ul>

          {returning && <p className="muted" role="status">Checking with DocuSign…</p>}
          {viewer.canSign && viaDocusign && (
            <section className="sg-sign stack" aria-label="Sign with DocuSign">
              <h2>Sign this document</h2>
              {view.mfaFresh === false && <p role="status">Signing is binding, so we ask you to confirm it's you with your second sign-in step first. <a href={`/mfa?next=${encodeURIComponent(`/signing/${id}`)}`}>Confirm now</a></p>}
              <p>This document is signed through DocuSign. You will go to DocuSign to review and sign, then come straight back here. Your signature, the time and your device details are recorded in the audit trail below.</p>
              <div className="sg-actions">
                <button type="button" disabled={busy} onClick={() => void openDocusign()}>{busy ? "Opening…" : "Sign with DocuSign"}</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => void act({ action: "refresh" }, "Could not check DocuSign.")}>I have signed: check status</button>
              </div>
              <p className="muted">To decline, use the decline option on the DocuSign page.</p>
            </section>
          )}
          {viewer.canSign && !viaDocusign && (
            <form className="sg-sign stack" onSubmit={e => { e.preventDefault(); void act({ action: "sign", typedName, consent }, "Could not sign the document."); }}>
              <h2>Sign this document</h2>
              {view.mfaFresh === false && <p role="status">Signing is binding, so we ask you to confirm it's you with your second sign-in step first. <a href={`/mfa?next=${encodeURIComponent(`/signing/${id}`)}`}>Confirm it's you</a></p>}
              <label>Type your full name, exactly as it appears on your account
                <input value={typedName} onChange={e => setTypedName(e.target.value)} autoComplete="name" required maxLength={120} />
              </label>
              <label className="check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required />
                <span>I have read this document and agree to sign it electronically. I understand my typed name, the time and my device details are recorded with the fingerprint above.</span></label>
              <div className="sg-actions">
                <button type="submit" disabled={busy || !consent || typedName.trim().length < 2}>{busy ? "Working…" : "Sign"}</button>
              </div>
              <label>Or decline (optional reason)
                <input value={reason} onChange={e => setReason(e.target.value)} maxLength={500} />
              </label>
              <div className="sg-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void act({ action: "decline", reason }, "Could not decline.")}>Decline to sign</button></div>
            </form>
          )}
          {viewer.role === "owner" && d.status === "draft" && (
            <div className="sg-actions">
              <button type="button" disabled={busy} onClick={() => void act({ action: "send" }, "Could not send the document.")}>Send for signature</button>
              <button type="button" className="secondary" disabled={busy} onClick={() => void act({ action: "cancel" }, "Could not cancel.")}>Cancel</button>
            </div>
          )}
          {viewer.role === "owner" && d.status === "out_for_signature" && (
            <div className="sg-actions">
              {viaDocusign && <button type="button" disabled={busy} onClick={() => void act({ action: "refresh" }, "Could not check DocuSign.")}>Check status with DocuSign</button>}
              <button type="button" className="secondary" disabled={busy} onClick={() => void act({ action: "cancel" }, "Could not cancel.")}>Cancel this document</button>
            </div>
          )}
          {viewer.role === "owner" && (d.status === "declined" || d.status === "cancelled") && (
            <div className="sg-actions"><button type="button" disabled={busy} onClick={() => void retry()}>Send again as a new document</button></div>
          )}
          {artifacts.length > 0 && (
            <>
              <h2>Signed copies</h2>
              <ul className="sg-signers">
                {artifacts.map(a => (
                  <li key={a.id}>
                    <a href={`/api/signing-documents/${d.id}/files/${a.kind}`} download>{a.kind === "signed_pdf" ? "Signed document (PDF)" : "Certificate of completion (PDF)"}</a>
                    <span className="muted">{Math.max(1, Math.round(a.sizeBytes / 1024))} KB · {new Date(a.createdAt).toLocaleString("en-AU")}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && <p role="alert">{error}</p>}

          <h2>Audit trail</h2>
          <p className="muted">Every step is recorded permanently and cannot be edited or deleted.</p>
          <ol className="sg-trail">
            {events.map(e => (
              <li key={e.id}>
                <span>{EVENT_LABEL[e.eventType] ?? e.eventType}{e.eventType === "explained" && typeof e.detail["clauseId"] === "string" ? ` (${d.clauses.find(c => c.id === e.detail["clauseId"])?.heading ?? "a clause"})` : ""}</span>
                <span className="muted">{e.actorName} · {new Date(e.occurredAt).toLocaleString("en-AU")}{e.ip ? ` · ${e.ip}` : ""}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </main>
  );
}
