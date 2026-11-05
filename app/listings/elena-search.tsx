"use client";
import { useId, useState } from "react";
import { JSON_HEADERS } from "./ui";
import { useSearchPersona } from "./persona-context";

interface Analysis { text: string; standouts: Array<{ label: string; listingId: string; title: string; detail: string }>; notes: string[] }
interface Assist {
  understood?: string[]; note?: string; analysis?: Analysis; narration?: string;
  relaxations?: Array<{ label: string; count: number; clear: string[] }>;
  answers?: Array<{ id: string; title: string; text: string; link?: { label: string; href: string } }>; overview?: string; error?: string;
}

const QUICK = ["How do I compare homes?", "How does the distance filter work?", "Can I get alerts for new listings?"];

/**
 * Elena on the search page. Three jobs, none needing the AI engine: turn a sentence into filters, state plain facts about the current
 * results (and say what to loosen when nothing matches), and explain the search tools. Her answers are labelled as general information.
 */
export function ElenaSearch({ query, total, onApply, onClear }: {
  /** Applied filters as URL parameters. */
  query: string; total: number | null;
  onApply: (params: Record<string, string>) => void;
  onClear: (names: string[]) => void;
}) {
  const persona = useSearchPersona();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Assist | null>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

  async function call(body: Record<string, unknown>): Promise<Assist | null> {
    setBusy(true);
    try {
      const r = await fetch("/api/search/assist", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = (await r.json()) as Assist;
      if (!r.ok) { setRes({ error: d.error ?? "Elena can't help right now. Try again in a moment." }); return null; }
      return d;
    } catch {
      setRes({ error: "Elena can't help right now. Try again in a moment." });
      return null;
    } finally { setBusy(false); }
  }
  async function find(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const d = await call({ mode: "interpret", text }) as (Assist & { params?: Record<string, string> }) | null;
    if (!d) return;
    setRes(d);
    if (d.params && Object.keys(d.params).length > 0) onApply(d.params);
  }
  async function analyse() {
    const d = await call({ mode: "analyse", query });
    if (d) setRes(d);
  }
  async function explain(q: string) {
    const d = await call({ mode: "explain", text: q });
    if (d) setRes(d);
  }

  return (
    <section className={`elena-search${open ? " open" : ""}`} aria-labelledby={`${id}-h`}>
      <div className="es-head">
        <img src={persona.icon} alt="" width={44} height={44} className="es-avatar" />
        <div>
          <h2 id={`${id}-h`}>Ask {persona.name} to search</h2>
          <p className="muted">Describe what you want in your own words, or ask about these results.</p>
        </div>
        <button type="button" className="secondary es-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Open"}</button>
      </div>
      <div id={`${id}-body`} hidden={!open} className="es-body">
        <form className="es-form" onSubmit={find}>
          <input aria-label={`Tell ${persona.name} what you are looking for`} placeholder="e.g. 3 bed house in Paddington under 900k with a pool" maxLength={300} value={text} onChange={e => setText(e.target.value)} />
          <button type="submit" disabled={busy || !text.trim()}>Set filters</button>
        </form>
        <div className="es-chips" role="group" aria-label="Other things to ask">
          <button type="button" className="secondary" disabled={busy || total === null} onClick={analyse}>Tell me about these results</button>
          {QUICK.map(q => <button key={q} type="button" className="secondary" disabled={busy} onClick={() => explain(q)}>{q}</button>)}
        </div>
        <div className="es-out" role="status" aria-live="polite">
          {busy && <p className="muted">{persona.name} is looking...</p>}
          {!busy && res?.error && <p role="alert">{res.error}</p>}
          {!busy && res?.understood && (
            <>
              {res.understood.length > 0 && <ul className="chips" aria-label="Filters set">{res.understood.map(u => <li key={u} className="chip">{u}</li>)}</ul>}
              <p>{res.note}</p>
            </>
          )}
          {!busy && res?.analysis && (
            <>
              <p>{res.narration ?? res.analysis.text}</p>
              {res.narration && <details><summary>The figures behind this</summary><p>{res.analysis.text}</p></details>}
              {res.analysis.standouts.length > 0 && <ul className="es-standouts">{res.analysis.standouts.map(s => <li key={s.label}>{s.label}: <a href={`/listings/${s.listingId}`}>{s.title}</a>, {s.detail}</li>)}</ul>}
              {res.relaxations && res.relaxations.length > 0 && (
                <div className="es-relax">
                  <p>Nothing matches. These changes would show listings:</p>
                  <ul>{res.relaxations.map(r => <li key={r.label}><button type="button" className="secondary" onClick={() => onClear(r.clear)}>Remove {r.label}</button> <span className="muted">{r.count}+ {r.count === 1 ? "listing" : "listings"}</span></li>)}</ul>
                </div>
              )}
              <small className="muted">{res.note}</small>
            </>
          )}
          {!busy && res?.answers && (
            <>
              {res.answers.length === 0 ? <p>{res.overview}</p> : res.answers.map(a => (
                <div key={a.id}><strong>{a.title}.</strong> {a.text}{a.link && <> <a href={a.link.href}>{a.link.label}</a></>}</div>
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
