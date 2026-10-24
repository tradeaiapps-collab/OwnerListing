"use client";
import { useEffect, useState } from "react";
import { ENGLISH_PREVAILS_NOTICE } from "../../src/domain/i18n";
import { JSON_HEADERS } from "../listings/ui";
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
      <h1>Terms and privacy</h1>
      <section className="terms-box" aria-label="Summary">
        <p><strong>Draft, pending review by Australian counsel.</strong> This summary is not the final legal text.</p>
        <ul>
          <li>The platform holds no money. Deposits go to the solicitor&apos;s trust account.</li>
          <li>AI helps with replies and reports, but only you decide on offers. AI never accepts an offer.</li>
          <li>Chat messages and published files are kept permanently and cannot be deleted.</li>
          <li>We collect personal information only as needed and handle it under the Privacy Act.</li>
        </ul>
        <p className="muted">{ENGLISH_PREVAILS_NOTICE}</p>
      </section>
      {state === "loading" && <p className="muted" role="status">Loading…</p>}
      {state === "signedOut" && <p role="alert"><a href="/api/auth/google/start?next=/terms">Sign in</a> to accept the terms.</p>}
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
