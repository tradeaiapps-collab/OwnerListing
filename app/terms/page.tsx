"use client";
import { useEffect, useState } from "react";
import { ENGLISH_PREVAILS_NOTICE } from "../../src/domain/i18n";
import { TERMS_LAST_UPDATED, TERMS_PARTS, TERMS_SUMMARY } from "../../src/domain/terms-content";
import { JSON_HEADERS } from "../listings/ui";
import BackLink from "../back-link";
import "../styles/settings.css";

type Current = { version: string; textReference: string; includesAiLearningClause: boolean };

export default function Terms() {
  const [state, setState] = useState<"loading" | "signedOut" | "error" | "ok">("loading");
  const [current, setCurrent] = useState<Current | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/terms")
      .then(async r => {
        if (r.status === 401) return setState("signedOut");
        if (!r.ok) return setState("error");
        const d = (await r.json()) as { current: Current | null; accepted: boolean };
        setCurrent(d.current); setAccepted(d.accepted); setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  const accept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !agree) return;
    setBusy(true); setError("");
    const r = await fetch("/api/terms", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ version: current.version, agree: true }) }).catch(() => null);
    setBusy(false);
    if (!r) return setError("Could not save. Check your connection and try again.");
    if (r.ok) return setAccepted(true);
    setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save.");
  };

  return (
    <main>
      <BackLink />
      <h1>Terms and privacy</h1>
      <p className="muted">Last updated {TERMS_LAST_UPDATED}</p>
      <section className="terms-box" aria-label="Summary">
        <p><strong>Draft, pending review by Australian counsel.</strong> The summary below is not the legal text; the full terms follow it.</p>
        <ul>
          {TERMS_SUMMARY.map(t => <li key={t}>{t}</li>)}
        </ul>
        <p className="muted">{ENGLISH_PREVAILS_NOTICE}</p>
      </section>
      <nav className="terms-toc" aria-label="Contents">
        <ol>
          {TERMS_PARTS.map(p => <li key={p.id}><a href={`#${p.id}`}>{p.title.replace(/^\d+\.\s*/, "")}</a></li>)}
        </ol>
      </nav>
      <article className="terms-full">
        {TERMS_PARTS.map(part => (
          <section key={part.id} id={part.id} aria-labelledby={`${part.id}-h`}>
            <h2 id={`${part.id}-h`}>{part.title}</h2>
            {part.sections.map(sec => (
              <div key={sec.id} id={sec.id}>
                <h3>{sec.title}</h3>
                {sec.paragraphs.map((t, i) => <p key={i}>{t}</p>)}
              </div>
            ))}
          </section>
        ))}
      </article>
      {state === "loading" && <p className="muted" role="status">Loading…</p>}
      {state === "signedOut" && <p role="alert"><a href="/login?next=/terms">Sign in</a> to accept the terms.</p>}
      {state === "error" && <p role="alert">Could not load the terms.</p>}
      {state === "ok" && !current && <p role="alert">No terms are in force yet.</p>}
      {state === "ok" && current && (accepted
        ? <p role="status">You have accepted version {current.version}. <a href="/dashboard">Go to your dashboard</a></p>
        : (
          <form className="terms-accept" onSubmit={accept}>
            <label className="terms-check">
              <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />
              <span>I have read and accept the terms and privacy policy (version {current.version})</span>
            </label>
            {error ? <p role="alert">{error}</p> : null}
            <button type="submit" disabled={busy || !agree}>{busy ? "Saving…" : "Accept"}</button>
          </form>
        ))}
    </main>
  );
}
