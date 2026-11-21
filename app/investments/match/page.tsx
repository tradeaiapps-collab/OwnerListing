"use client";
import { useCallback, useEffect, useState } from "react";
import {
  RISK_LABEL, STEPS, TIMEFRAME_LABEL, promptFor, type InvestorPrefs, type Step
} from "../../../src/domain/elena-investor-match";
import type { ElenaMatchState } from "../../../src/domain/elena-investor-match-service";
import { AU_JURISDICTIONS } from "../../../src/domain/jurisdiction";
import { aud, label, send, STEP_LINK } from "../ui";

const QUICK = [50_000, 100_000, 250_000, 500_000, 1_000_000];
const BASE = "/api/investments/investor/elena";

const answerText = (step: Step, p: InvestorPrefs): string => {
  switch (step) {
    case "budget": return p.budgetMaxCents ? `Up to ${aud(p.budgetMaxCents)} in one project` : "";
    case "risk": return p.risk ? RISK_LABEL[p.risk] : "";
    case "location": return `${p.jurisdictions && p.jurisdictions.length > 0 ? p.jurisdictions.join(", ") : "Anywhere in Australia"}${p.suburbs.length > 0 ? `, near ${p.suburbs.join(", ")}` : ""}`;
    case "timeframe": return p.timeframe ? TIMEFRAME_LABEL[p.timeframe] : "";
  }
};
const fit = (score: number) => (score >= 85 ? "Strong fit" : score >= 65 ? "Good fit" : "Partial fit");

/** Elena asks four short questions (budget, risk, place, timeframe), saves the answers, then lists matching projects with the reasons. Matching only. */
export default function ElenaMatch() {
  const [s, setS] = useState<ElenaMatchState | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Step | null>(null);
  const [dollars, setDollars] = useState("");
  const [states, setStates] = useState<string[]>([]);
  const [suburbs, setSuburbs] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(BASE).catch(() => null);
    if (!r) { setError("Could not load Elena."); return; }
    const d = await r.json().catch(() => ({}));
    if (r.ok) { setError(""); setS(d); } else { setError(r.status === 401 ? "Sign in with an investor (buyer) account." : d.error ?? "Could not load Elena."); setStep(r.status === 401 ? "investor_account" : d.step ?? ""); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function answer(st: Step, value: Record<string, unknown>) {
    setError(""); setBusy(true);
    const r = await send(BASE, "POST", { step: st, value });
    setBusy(false);
    if (r.ok) { setS(r.data as unknown as ElenaMatchState); setEditing(null); setDollars(""); } else setError(String(r.data["error"] ?? "Elena could not save that."));
  }
  async function clear() {
    setBusy(true);
    const r = await send(BASE, "DELETE", {});
    setBusy(false);
    if (r.ok) { setEditing(null); setStates([]); setSuburbs(""); await load(); } else setError(String(r.data["error"] ?? "Could not clear."));
  }
  const startEdit = (st: Step) => {
    setEditing(st);
    if (st === "location" && s) { setStates(s.prefs.jurisdictions ?? []); setSuburbs(s.prefs.suburbs.join(", ")); }
    if (st === "budget" && s?.prefs.budgetMaxCents) setDollars(String(s.prefs.budgetMaxCents / 100));
  };

  const current: Step | null = editing ?? s?.next?.step ?? null;
  const asked = s ? STEPS.filter(st => answerText(st, s.prefs) !== "" && !(s.prefs.jurisdictions === undefined && st === "location")) : [];
  const link = STEP_LINK[step];
  const prompt = current ? promptFor(current) : null;

  return (
    <main className="match">
      <header className="inv-page-head">
        <div>
          <h1>Find projects with Elena</h1>
          <p className="muted">Four quick questions, then Elena lists the projects that fit and tells you why.</p>
        </div>
        <nav className="inv-page-links" aria-label="Investor pages"><a href="/investments">All projects</a></nav>
      </header>
      {s && <p className="elena-notice" role="note">{s.notice}</p>}
      {error && <p role="alert" className="inv-error">{error} {link && <a href={link[0]}>{link[1]}</a>}</p>}
      {!s && !error && <p className="muted" role="status">Loading…</p>}

      {s && (
        <section className="match-chat" aria-label="Conversation with Elena" aria-live="polite">
          {asked.filter(st => st !== current).map(st => (
            <div key={st} className="match-turn">
              <p className="match-bubble elena">{promptFor(st).text}</p>
              <p className="match-bubble me">
                <span>{answerText(st, s.prefs)}</span>
                <button type="button" className="secondary match-change" onClick={() => startEdit(st)} disabled={busy}>Change<span className="sr-only"> {st} answer</span></button>
              </p>
            </div>
          ))}
          {prompt && (
            <div className="match-turn">
              <p className="match-bubble elena">{prompt.text}</p>
              {prompt.hint && <p className="muted inv-small match-hint">{prompt.hint}</p>}
              {prompt.kind === "amount" && (
                <form className="match-form" onSubmit={e => { e.preventDefault(); void answer("budget", { budgetMaxCents: Math.round(Number(dollars) * 100) }); }}>
                  <div className="match-chips" role="group" aria-label="Quick amounts">
                    {QUICK.map(q => <button key={q} type="button" className="secondary" onClick={() => setDollars(String(q))} aria-pressed={dollars === String(q)}>{aud(q * 100)}</button>)}
                  </div>
                  <label htmlFor="match-amount">Most I'd consider in one project (AUD)</label>
                  <input id="match-amount" type="number" inputMode="numeric" min={1} step={1} required value={dollars} onChange={e => setDollars(e.target.value)} />
                  <button type="submit" disabled={busy || !(Number(dollars) >= 1)}>Continue</button>
                </form>
              )}
              {prompt.kind === "choice" && (
                <div className="match-options" role="group" aria-label="Choose one">
                  {prompt.options!.map(o => <button key={o.value} type="button" className="secondary" disabled={busy} onClick={() => void answer(prompt.step, { [prompt.step]: o.value })}>{o.label}</button>)}
                </div>
              )}
              {prompt.kind === "location" && (
                <form className="match-form" onSubmit={e => { e.preventDefault(); void answer("location", { jurisdictions: states, suburbs: suburbs.split(",").map(x => x.trim()).filter(Boolean) }); }}>
                  <fieldset>
                    <legend>States and territories</legend>
                    <div className="match-chips">
                      {AU_JURISDICTIONS.map(j => (
                        <label key={j} className="match-check"><input type="checkbox" checked={states.includes(j)} onChange={e => setStates(v => (e.target.checked ? [...v, j] : v.filter(x => x !== j)))} />{j}</label>
                      ))}
                    </div>
                    <p className="muted inv-small">Leave all unticked for anywhere in Australia.</p>
                  </fieldset>
                  <label htmlFor="match-suburbs">Suburbs (optional, up to 5, separated by commas)</label>
                  <input id="match-suburbs" type="text" maxLength={240} value={suburbs} onChange={e => setSuburbs(e.target.value)} placeholder="Bulimba, Newstead" />
                  <button type="submit" disabled={busy}>{states.length === 0 ? "Anywhere in Australia" : "Continue"}</button>
                </form>
              )}
              {editing && <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>}
            </div>
          )}

          {!current && s.results && (
            <div className="match-turn">
              <p className="match-bubble elena">Thanks. Here is what I heard: {s.summary} {s.results.cards.length > 0 ? `I found ${s.results.cards.length} project${s.results.cards.length === 1 ? "" : "s"} that fit, best first.` : "I couldn't find a project that fits all of that right now."}</p>
              {s.results.cards.length === 0 && (
                <p className="muted match-hint" role="status">
                  Of {s.results.considered} project{s.results.considered === 1 ? "" : "s"} open to you, {s.results.excluded.budget} had a minimum above your budget, {s.results.excluded.risk} were earlier-stage than your risk setting, and {s.results.excluded.location} were outside your places. Use Change above to widen one, or check back as new projects are approved.
                </p>
              )}
              <ul className="match-list">
                {s.results.cards.map(c => (
                  <li key={c.project.id} className="match-card">
                    <p className="pcard-eyebrow">{label(c.project.projectType)} · {label(c.project.stage)}</p>
                    <h2 className="pcard-title"><a href={`/investments/${c.project.id}`}>{c.project.title}</a></h2>
                    <p className="pcard-where">{c.project.location}, {c.project.jurisdiction} · Minimum {aud(c.project.minimumTicketCents)} · Issuer: {c.project.issuerName}</p>
                    <span className="elena-tag answered">{fit(c.match.score)}</span>
                    <h3>Why Elena matched it</h3>
                    <ul>{c.match.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    {c.match.cautions.length > 0 && (<><h3>Things to check</h3><ul className="match-cautions">{c.match.cautions.map((r, i) => <li key={i}>{r}</li>)}</ul></>)}
                    <details>
                      <summary>What the owner says</summary>
                      <p><strong>Timeline:</strong> {c.match.ownerTimeline}</p>
                      <p><strong>Risks:</strong> {c.match.ownerRisks}</p>
                    </details>
                    <p className="elena-actions"><a className="button" href={`/investments/${c.project.id}`}>Open project and documents</a></p>
                  </li>
                ))}
              </ul>
              <p className="elena-actions"><button type="button" className="secondary" onClick={clear} disabled={busy}>Clear my answers and start again</button></p>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
