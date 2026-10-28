"use client";
import { useEffect, useState } from "react";
import { personaLabel, type Persona, type PersonaId } from "../../../src/domain/assistant-persona";
import { loadError } from "../staff-api";

interface View { current: PersonaId; history: { persona: PersonaId; chosenBy: string; chosenAt: string }[]; personas: Persona[]; canChange: boolean }

/** The assistant's character: five fixed personas, one live. Saving makes the choice live at once (no draft). */
export default function PersonaPicker() {
  const [view, setView] = useState<View | null>(null);
  const [pick, setPick] = useState<PersonaId | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/staff/assistant/persona").catch(() => null);
      if (r?.status === 403) { setHidden(true); return; } // the page above already says the role cannot use this screen
      if (!r?.ok) { setError(loadError(r?.status ?? 0)); return; }
      const v = (await r.json()) as View;
      setView(v); setPick(v.current);
    })();
  }, []);

  const save = async () => {
    if (!pick) return;
    setBusy(true); setError(""); setNote("");
    const r = await fetch("/api/staff/assistant/persona", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ persona: pick }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    if (!r?.ok) { setError(d.error ?? "Could not save."); return; }
    setView(d as View); setPick((d as View).current);
    setNote("Saved. The public site shows the new assistant within about a minute.");
  };

  if (hidden) return null;
  if (!view || !pick) {
    return (
      <section className="panel ga-persona" aria-labelledby="ga-h-persona">
        <h2 id="ga-h-persona">Assistant character</h2>
        {error ? <p role="alert" className="ga-error">{error}</p> : <p className="muted" role="status">Loading…</p>}
      </section>
    );
  }
  const chosen = view.personas.find(p => p.id === pick) ?? view.personas[0]!;
  const live = view.personas.find(p => p.id === view.current);
  const last = view.history[0];

  return (
    <section className="panel ga-persona" aria-labelledby="ga-h-persona">
      <h2 id="ga-h-persona">Assistant character</h2>
      <p className="muted">The face and name of the guide on the public site: the chat button, the chat window and the home page greeter. She is always labelled &ldquo;AI assistant&rdquo;.</p>
      <p className="staff-notice">Live now: <strong>{live ? personaLabel(live) : view.current}</strong>{last ? <>, chosen by {last.chosenBy} on {new Date(last.chosenAt).toLocaleString("en-AU")}</> : " (the default)"}.</p>
      {!view.canChange && <p className="staff-notice">Changing the assistant needs the &ldquo;Publish website content&rdquo; permission. Ask a super admin.</p>}
      <fieldset className="ga-persona-grid" disabled={!view.canChange || busy}>
        <legend className="ga-sr">Choose the assistant</legend>
        {view.personas.map(p => (
          <label key={p.id} className={`ga-persona-tile${p.id === pick ? " is-picked" : ""}`}>
            <input type="radio" name="persona" value={p.id} checked={p.id === pick} onChange={() => { setPick(p.id); setNote(""); }} />
            <img src={p.portrait} alt="" width={512} height={512} loading="lazy" decoding="async" />
            <span className="ga-persona-name">{p.name}{p.id === view.current && <span className="ga-persona-live">Live</span>}</span>
            <span className="ga-persona-kind">{p.kind}</span>
            <span className="ga-persona-blurb">{p.blurb}</span>
          </label>
        ))}
      </fieldset>

      <div className="ga-persona-preview" aria-label="Preview">
        <p className="eyebrow">Preview</p>
        <div className="ga-persona-chat">
          <div className="ga-persona-chat-head">
            <img src={chosen.icon} alt="" width={40} height={40} />
            <div><strong>{chosen.name}</strong><span>AI assistant · automatic answers</span></div>
          </div>
          <p className="ga-persona-bubble">Hi, I&apos;m {chosen.name}. I can show you how to list your home, how offers work, or what to do next.</p>
        </div>
      </div>

      {error && <p role="alert" className="ga-error">{error}</p>}
      {note && <p role="status">{note}</p>}
      {view.canChange && (
        <div className="ga-persona-actions">
          <button type="button" onClick={() => void save()} disabled={busy || pick === view.current}>{busy ? "Saving…" : `Use ${chosen.name}`}</button>
          {pick !== view.current && <button type="button" className="secondary" onClick={() => setPick(view.current)} disabled={busy}>Cancel</button>}
        </div>
      )}
    </section>
  );
}
