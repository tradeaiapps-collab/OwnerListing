"use client";
import { useEffect, useState } from "react";
import { GUIDE_INTENTS, type GuideContent, type GuideIntent } from "../../../src/domain/guide-assistant";
import Breadcrumbs from "../../breadcrumbs";
import { loadError } from "../staff-api";
import "../../styles/staff.css";
import "../../styles/site-editor.css";
import "../../styles/assistant.css";

interface View {
  draftVersion: number | null; liveVersion: number | null; draft: GuideContent; live: GuideContent;
  versions: { version: number; createdBy: string; createdAt: string; live: boolean }[];
  limits: { greeting: number; chipLabel: number; chips: number; question: number; answer: number; supportText: number; url: number };
  disclaimer: string;
}

const TOPIC: Record<GuideIntent, string> = {
  next_step: "What to do next", how_to_list: "How to list", documents: "Documents needed", verification: "Verification", offers: "Offers",
  fees: "Fees and plans", enquire: "Enquiring", saved_searches: "Saved searches", dashboard: "Dashboard", support: "Support"
};

/** Guide assistant content: on/off, greeting, quick replies, answers and support contact. Saved as insert-only versions; publish makes one live. */
export default function StaffAssistant() {
  const [view, setView] = useState<View | null>(null);
  const [c, setC] = useState<GuideContent | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});

  const load = async () => {
    const r = await fetch("/api/staff/assistant").catch(() => null);
    if (!r?.ok) { setError(loadError(r?.status ?? 0)); return; }
    const v = (await r.json()) as View;
    setView(v); setC(structuredClone(v.draft));
  };
  useEffect(() => { void load(); }, []);

  const send = async (url: string, method: string, body: unknown, ok: string) => {
    setError(""); setNote(""); setFields({});
    const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(d.error ?? "Could not save."); setFields(d.fields ?? {}); return; }
    setView(d as View); setC(structuredClone((d as View).draft)); setNote(ok);
  };

  if (!view || !c) return <main><h1>Guide assistant</h1>{error ? <p role="alert">{error}</p> : <p className="muted" role="status">Loading…</p>}</main>;
  const L = view.limits;
  const up = (f: (x: GuideContent) => void) => setC(cur => { const n = structuredClone(cur!); f(n); return n; });
  const fe = (p: string) => (fields[p] ? <small className="se-err" role="alert">{fields[p]}</small> : null);
  const unsaved = JSON.stringify(c) !== JSON.stringify(view.draft);
  const canPublish = view.draftVersion !== null && view.draftVersion !== view.liveVersion && !unsaved;

  return (
    <main className="ga-staff">
      <Breadcrumbs trail={[{ label: "Staff home", href: "/staff" }, { label: "Guide assistant" }]} />
      <h1>Guide assistant</h1>
      <p className="muted">The chat guide on every public page. It gives fixed answers written here; links are set in code. Plain text only (no HTML). Visitor messages are never stored.</p>
      <p className="staff-notice">Live version: <strong>{view.liveVersion ?? "built-in defaults"}</strong>. Draft version: <strong>{view.draftVersion ?? "none"}</strong>.{unsaved && " You have unsaved changes."}</p>
      {error && <p role="alert" className="ga-error">{error}</p>}
      {note && <p role="status">{note}</p>}

      <section className="panel" aria-labelledby="ga-h-main">
        <h2 id="ga-h-main">Switch and greeting</h2>
        <label className="ga-check"><input type="checkbox" checked={c.enabled} onChange={e => up(x => { x.enabled = e.target.checked; })} /> Show the guide on the public site</label>
        <label className="se-field">Greeting <span className="muted">(up to {L.greeting} characters)</span>
          <textarea rows={3} maxLength={L.greeting} value={c.greeting} onChange={e => up(x => { x.greeting = e.target.value; })} />{fe("greeting")}
        </label>
        <p className="muted">Disclaimer shown under every answer (fixed): {view.disclaimer}</p>
      </section>

      <section className="panel" aria-labelledby="ga-h-chips">
        <h2 id="ga-h-chips">Quick replies</h2>
        <p className="muted">Up to {L.chips}. Each opens one topic. The page the visitor is on may move the most useful ones first.</p>
        <ol className="ga-chip-list">
          {c.chips.map((ch, i) => (
            <li key={`${ch.intent}-${i}`}>
              <label>Topic
                <select value={ch.intent} onChange={e => up(x => { x.chips[i]!.intent = e.target.value as GuideIntent; })}>
                  {GUIDE_INTENTS.map(t => <option key={t} value={t}>{TOPIC[t]}</option>)}
                </select>
              </label>
              <label>Button text
                <input maxLength={L.chipLabel} value={ch.label} onChange={e => up(x => { x.chips[i]!.label = e.target.value; })} />
              </label>
              <button type="button" className="secondary" onClick={() => up(x => { x.chips.splice(i, 1); })} disabled={c.chips.length <= 1}>Remove</button>
              {fe(`chips.${i}.intent`)}{fe(`chips.${i}.label`)}
            </li>
          ))}
        </ol>
        {fe("chips")}
        {c.chips.length < L.chips && (
          <button type="button" className="secondary" onClick={() => up(x => {
            const free = GUIDE_INTENTS.find(t => !x.chips.some(ch => ch.intent === t)) ?? "support";
            x.chips.push({ intent: free, label: x.faq[free].question.slice(0, L.chipLabel) });
          })}>Add a quick reply</button>
        )}
      </section>

      <section className="panel" aria-labelledby="ga-h-faq">
        <h2 id="ga-h-faq">Answers</h2>
        <p className="muted">Each topic&apos;s question and answer. Six of them also appear as the FAQ on the home page. Keep answers factual; never promise outcomes or give legal or financial advice.</p>
        {GUIDE_INTENTS.map(t => (
          <fieldset key={t} className="ga-faq">
            <legend>{TOPIC[t]}</legend>
            <label className="se-field">Question <input maxLength={L.question} value={c.faq[t].question} onChange={e => up(x => { x.faq[t].question = e.target.value; })} />{fe(`faq.${t}.question`)}</label>
            <label className="se-field">Answer <span className="muted">(up to {L.answer} characters)</span>
              <textarea rows={3} maxLength={L.answer} value={c.faq[t].answer} onChange={e => up(x => { x.faq[t].answer = e.target.value; })} />{fe(`faq.${t}.answer`)}
            </label>
          </fieldset>
        ))}
      </section>

      <section className="panel" aria-labelledby="ga-h-sup">
        <h2 id="ga-h-sup">Support contact</h2>
        <label className="se-field">Text <input maxLength={L.supportText} value={c.support.text} onChange={e => up(x => { x.support.text = e.target.value; })} />{fe("support.text")}</label>
        <label className="se-field">Link <span className="muted">(https:// or a page on this site such as /terms; leave empty for none)</span>
          <input maxLength={L.url} value={c.support.href ?? ""} onChange={e => up(x => { x.support.href = e.target.value.trim() === "" ? null : e.target.value; })} />{fe("support.href")}
        </label>
      </section>

      <div className="ga-actions">
        <button type="button" onClick={() => void send("/api/staff/assistant", "PUT", { baseVersion: view.draftVersion, content: c }, "Draft saved. Publish it to make it live.")} disabled={!unsaved && view.draftVersion !== null}>Save draft</button>
        <button type="button" className="secondary" onClick={() => window.confirm(`Make draft version ${view.draftVersion} live?`) && void send("/api/staff/assistant/publish", "POST", { version: view.draftVersion }, "Published. The site picks it up within about a minute.")} disabled={!canPublish}>Publish draft</button>
        <button type="button" className="secondary" onClick={() => setC(structuredClone(view.draft))} disabled={!unsaved}>Discard changes</button>
      </div>

      <section aria-labelledby="ga-h-hist">
        <h2 id="ga-h-hist">History</h2>
        {view.versions.length === 0 ? <p className="muted">No versions saved yet. The built-in defaults are live.</p> : (
          <ul className="stack-tight">
            {view.versions.map(v => <li key={v.version}>Version {v.version}, {new Date(v.createdAt).toLocaleString("en-AU")}, by {v.createdBy}{v.live && <strong> (live)</strong>}</li>)}
          </ul>
        )}
      </section>
    </main>
  );
}
