"use client";
import { useCallback, useEffect, useState } from "react";
import { posterText } from "../../../../src/domain/investment-terms";
import { loadError, postStaff } from "../../staff-api";

type History = { enabled: boolean; counselConfirmed: boolean; disclosureVersion: string; changedBy: string; changedAt: string };
type View = { envOn: boolean; dbOn: boolean; live: boolean; history: History[]; disclosure: { version: string; title: string; text: string }; confirmation: string };
type Model = "commission_on_contract" | "upfront_fee";
type Settings = { model: Model; commissionType: "percent" | "fixed"; commissionBps: number; commissionFixedCents: number; upfrontFeeCents: number; model2Disclosure: "off" | "after_fee" | "after_contract" };
type Posting = { settings: Settings; posterText: string; explainers: Record<Model, { name: string; how: string; details: string; whoSees: string }>; history: { settings: Settings; changedBy: string; changedAt: string }[] };

/** Super admin only. Two-key switch (server env + this database switch) and the posting model for new projects. */
export default function InvestmentSettings() {
  const [view, setView] = useState<View | null>(null);
  const [posting, setPosting] = useState<Posting | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([fetch("/api/staff/investments/settings").catch(() => null), fetch("/api/staff/investments/posting").catch(() => null)]);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setView(await r.json());
    if (p?.ok) { const d = await p.json(); setPosting(d); setDraft(d.settings); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function toggle(enabled: boolean) {
    if (!window.confirm(enabled ? "Turn the database switch ON? If the server key is also on, investor pages go live at once." : "Turn the investor module OFF now? Every investor page and API answers 404 until it is turned on again.")) return;
    setError(""); setNote("");
    const r = await postStaff("/api/staff/investments/settings", { enabled, counselConfirmed: enabled ? confirmed : false, disclosureVersion: view?.disclosure.version });
    if (r.ok) { setView(r.data as unknown as View); setConfirmed(false); setNote(enabled ? "Database switch turned on." : "Turned off. Investor pages and APIs now answer 404."); }
    else setError(String(r.data["error"] ?? "Could not change."));
  }
  async function savePosting(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setNote("");
    const r = await postStaff("/api/staff/investments/posting", draft);
    if (r.ok) { const d = r.data as unknown as Posting; setPosting(d); setDraft(d.settings); setNote("Posting model saved. It applies to projects posted from now on."); }
    else setError(String(r.data["error"] ?? "Could not save."));
  }
  const set = (patch: Partial<Settings>) => draft && setDraft({ ...draft, ...patch });
  const dirty = !!draft && !!posting && JSON.stringify(draft) !== JSON.stringify(posting.settings);

  return (
    <main className="sr-page">
      <p className="inv-back"><a href="/staff/investments">Back to investor projects</a></p>
      <header className="inv-page-head">
        <div>
          <h1>Investor module settings</h1>
          <p className="muted">The module is live only when both keys are on: the server setting INVESTMENT_MODULE_ENABLED and the switch below. Turning off hides every investor page, link and API at once; no data is deleted.</p>
        </div>
      </header>
      <nav className="sr-subnav" aria-label="On this page"><a href="#switch">Module switch</a>{posting && <a href="#posting">Posting model</a>}<a href="#history">Switch history</a></nav>
      <div aria-live="polite">
        {error && <p role="alert" className="sr-banner is-error">{error}</p>}
        {note && <p role="status" className="sr-banner is-ok">{note}</p>}
      </div>
      {!view && !error && <p className="muted" role="status">Loading…</p>}
      {view && (
        <>
          <section id="switch" className="sr-section">
          <h2>Module switch</h2>
          <div className={`inv-switch ${view.live ? "is-live" : "is-off"}`} aria-live="polite">
            <span className={`inv-state ${view.live ? "on" : "off"}`}>Module {view.live ? "ON (live)" : "OFF"}</span>
            <span className="inv-key">Server key <strong className={view.envOn ? "on" : "off"}>{view.envOn ? "on" : "off"}</strong></span>
            <span className="inv-key">Database switch <strong className={view.dbOn ? "on" : "off"}>{view.dbOn ? "on" : "off"}</strong></span>
          </div>
          {!view.envOn && <p className="staff-notice">The server key is off, so the module stays off whatever this switch says.</p>}
          <section className="panel">
            <h2>{view.disclosure.title} <small className="muted">version {view.disclosure.version}</small></h2>
            <p>{view.disclosure.text}</p>
          </section>
          <form className="inv-form" onSubmit={e => e.preventDefault()}>
            <label className="inv-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{view.confirmation} (version {view.disclosure.version}).</label>
            <div className="actions">
              <button type="button" disabled={view.dbOn || !confirmed} onClick={() => void toggle(true)}>Turn database switch ON</button>
              <button type="button" className="secondary danger" disabled={!view.dbOn} onClick={() => void toggle(false)}>Turn OFF now</button>
            </div>
          </form>
          </section>
          <section id="history" className="sr-section">
          <details className="sr-more" open={view.history.length <= 5}>
          <summary>Switch history ({view.history.length})</summary>
          <div className="inv-table-wrap">
            <table className="inv-history">
              <thead><tr><th>When</th><th>Change</th><th>Counsel confirmed</th><th>Disclosure version</th><th>By</th></tr></thead>
              <tbody>
                {view.history.length === 0 && <tr><td colSpan={5}>Never changed (off by default).</td></tr>}
                {view.history.map(h => <tr key={h.changedAt + h.changedBy}><td>{new Date(h.changedAt).toLocaleString("en-AU")}</td><td>{h.enabled ? "ON" : "OFF"}</td><td>{h.counselConfirmed ? "yes" : "no"}</td><td>{h.disclosureVersion}</td><td>{h.changedBy.slice(0, 8)}</td></tr>)}
              </tbody>
            </table>
          </div>
          </details>
          </section>
        </>
      )}
      {posting && draft && (
        <section id="posting" className="sr-section">
          <h2>Posting model</h2>
          <p className="muted">Applies to projects posted after you save. Each project keeps the model and fee it was posted under. Counsel must review both models before the module goes live.</p>
          <div className="sr-models">
          {(Object.keys(posting.explainers) as Model[]).map(m => (
            <div key={m} className={posting.settings.model === m ? "panel sr-model is-current" : "panel sr-model"}>
              <h3>{posting.explainers[m].name}{posting.settings.model === m && <span className="inv-status approved">Current</span>}</h3>
              <p><strong>How it works:</strong> {posting.explainers[m].how}</p>
              <p><strong>Details:</strong> {posting.explainers[m].details}</p>
              <p><strong>Who sees what:</strong> {posting.explainers[m].whoSees}</p>
            </div>
          ))}
          </div>
          <form className="inv-form" onSubmit={savePosting}>
            <label>Model
              <select value={draft.model} onChange={e => set({ model: e.target.value as Model })}>
                <option value="commission_on_contract">Model 1: Free posting, commission on first investment</option>
                <option value="upfront_fee">Model 2: Upfront fee, full disclosure</option>
              </select>
            </label>
            {draft.model === "commission_on_contract" ? (
              <>
                <label>Commission type
                  <select value={draft.commissionType} onChange={e => set({ commissionType: e.target.value as Settings["commissionType"] })}>
                    <option value="percent">Percentage of the signed contract amount</option><option value="fixed">Fixed amount</option>
                  </select>
                </label>
                {draft.commissionType === "percent"
                  ? <label>Commission (%)<input inputMode="decimal" value={draft.commissionBps / 100} onChange={e => set({ commissionBps: Math.round(Number(e.target.value) * 100) || 0 })} /></label>
                  : <label>Fixed commission (AUD)<input inputMode="decimal" value={draft.commissionFixedCents / 100} onChange={e => set({ commissionFixedCents: Math.round(Number(e.target.value) * 100) || 0 })} /></label>}
              </>
            ) : (
              <>
                <label>Upfront posting fee (AUD)<input inputMode="decimal" value={draft.upfrontFeeCents / 100} onChange={e => set({ upfrontFeeCents: Math.round(Number(e.target.value) * 100) || 0 })} /></label>
                <label>When contact details may be shown
                  <select value={draft.model2Disclosure} onChange={e => set({ model2Disclosure: e.target.value as Settings["model2Disclosure"] })}>
                    <option value="off">Never (keep hidden)</option><option value="after_fee">After the upfront fee is paid</option><option value="after_contract">After the fee is paid and a signed contract is returned</option>
                  </select>
                </label>
              </>
            )}
            <div className="panel"><h3>Preview: what posters will see</h3><p>{posterText(draft)}</p></div>
            <div className="sr-savebar">
              <button type="submit" disabled={!dirty}>Save posting model</button>
              <button type="button" className="secondary" disabled={!dirty} onClick={() => setDraft(posting.settings)}>Undo changes</button>
              <p role="status">{dirty ? "You have unsaved changes." : "Saved settings are shown."}</p>
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
