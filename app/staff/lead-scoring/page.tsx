"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../../styles/admin.css";
import "../../styles/feeds.css";
import { JSON_HEADERS } from "../../listings/ui";

type Config = { hotMin: number; warmMin: number; weights: { engagement: number; fit: number; followUp: number } };

/** Staff screen for lead scoring rules: hot and warm thresholds and the weights of the three parts of a score. feeds.manage only. */
export default function StaffLeadScoring() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [defaults, setDefaults] = useState<Config | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/lead-scoring").catch(() => null);
    if (!r) return setError("Could not load the scoring rules.");
    if (r.status === 401) return setError("Sign in as staff to manage lead scoring.");
    if (r.status === 403) return setError("Your role cannot manage lead scoring.");
    if (!r.ok) return setError("Could not load the scoring rules.");
    const d = await r.json();
    setCfg(d.config); setDefaults(d.defaults); setError("");
  }, []);
  useEffect(() => { void load(); }, [load]);

  const total = cfg ? cfg.weights.engagement + cfg.weights.fit + cfg.weights.followUp : 0;
  const num = (v: string) => (v === "" ? 0 : Math.trunc(Number(v)));

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!cfg) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch("/api/staff/lead-scoring", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(cfg) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? "Could not save."); return; }
      setNotice("Saved. New scores use these rules straight away.");
    } finally { setBusy(false); }
  }

  return (
    <main className="feeds">
      <h1>Lead scoring</h1>
      <p className="muted">Every lead gets a score from 0 to 100 made of three parts: how engaged the buyer is (offers, messages, recent activity), how well the property fits the buyer's saved searches, and how urgent the follow-up is. Agents see the result as hot, warm or cold and can override one lead's score with a reason.</p>
      {error && <p role="alert" className="feeds-msg bad">{error}</p>}
      {notice && <p role="status" className="feeds-msg">{notice}</p>}
      {!cfg && !error && <p className="muted" role="status">Loading…</p>}
      {cfg && (
        <form className="stack feeds-form" onSubmit={save}>
          <h2>Bands</h2>
          <div className="feeds-grid">
            <label>Hot from (score) <input type="number" min={2} max={100} step={1} value={cfg.hotMin} onChange={e => setCfg({ ...cfg, hotMin: num(e.target.value) })} required /></label>
            <label>Warm from (score) <input type="number" min={1} max={99} step={1} value={cfg.warmMin} onChange={e => setCfg({ ...cfg, warmMin: num(e.target.value) })} required /></label>
          </div>
          <p className="muted">Below the warm score a lead is cold.</p>
          <h2>Weights (percent)</h2>
          <div className="feeds-grid">
            <label>Engagement <input type="number" min={0} max={100} step={1} value={cfg.weights.engagement} onChange={e => setCfg({ ...cfg, weights: { ...cfg.weights, engagement: num(e.target.value) } })} required /></label>
            <label>Property fit <input type="number" min={0} max={100} step={1} value={cfg.weights.fit} onChange={e => setCfg({ ...cfg, weights: { ...cfg.weights, fit: num(e.target.value) } })} required /></label>
            <label>Follow-up timing <input type="number" min={0} max={100} step={1} value={cfg.weights.followUp} onChange={e => setCfg({ ...cfg, weights: { ...cfg.weights, followUp: num(e.target.value) } })} required /></label>
          </div>
          <p className={total === 100 ? "muted" : "feeds-msg bad"} role="status">Total {total} of 100{total === 100 ? "" : ": the weights must add up to 100."}</p>
          <p className="muted">A buyer with no saved search has no fit part; the other weights are scaled up so missing data never lowers a score.</p>
          <div className="row-actions">
            <button type="submit" disabled={busy || total !== 100}>{busy ? "Saving…" : "Save rules"}</button>
            {defaults && <button type="button" className="secondary" disabled={busy} onClick={() => setCfg(defaults)}>Reset to defaults</button>}
          </div>
        </form>
      )}
    </main>
  );
}
