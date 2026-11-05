"use client";
import { useEffect, useState, type FormEvent } from "react";
import type { Analysis } from "../../../src/domain/feasibility";
import { loadError } from "../staff-api";
import "../../styles/admin.css";

interface History { id: string; name: string; points: number; weeks: number; outcome: "succeeded" | "failed" }
const lines = (s: string) => s.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
const SEV: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };

/** Staff describe a proposal; Elena scores complexity, lists risks and compares it with finished projects. Advice only. */
export default function StaffFeasibility() {
  const [history, setHistory] = useState<History[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const load = () => fetch("/api/staff/feasibility").then(async r => { if (r.ok) setHistory((await r.json()).history); else setError(loadError(r.status)); }).catch(() => setError(loadError(0)));
  useEffect(() => { void load(); }, []);

  async function analyse(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setBusy(true);
    const f = new FormData(e.currentTarget), g = (k: string) => String(f.get(k) ?? "");
    const body = { title: g("title"), description: g("description"), timelineWeeks: Number(g("timelineWeeks")), teamSize: Number(g("teamSize")), systemsTouched: Number(g("systemsTouched")),
      newTechnologies: lines(g("newTechnologies")), externalDependencies: lines(g("externalDependencies")), compliance: f.get("compliance") === "on", legalSignOff: f.get("legalSignOff") === "on",
      requirements: g("requirements"), teamHasExpertise: g("teamHasExpertise"), budgetJustified: g("budgetJustified") };
    const r = await fetch("/api/staff/feasibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!r) return setError(loadError(0));
    const j = await r.json().catch(() => ({}));
    if (r.ok) setResult(j.analysis); else setError(j.error ?? loadError(r.status));
  }

  async function addHistory(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    const form = e.currentTarget, f = new FormData(form), g = (k: string) => String(f.get(k) ?? "");
    const r = await fetch("/api/staff/feasibility/history", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: g("name"), points: Number(g("points")), weeks: Number(g("weeks")), outcome: g("outcome") }) }).catch(() => null);
    if (!r) return setError(loadError(0));
    if (r.ok) { form.reset(); await load(); } else setError((await r.json().catch(() => ({}))).error ?? loadError(r.status));
  }

  return (
    <main className="admin-page">
      <h1>Project feasibility</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">Elena scores a proposal on a story point scale, lists the risks and compares it with finished projects. It is advice from fixed rules. It does not assign people, forecast budget or review contracts.</p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={analyse} className="form-grid">
        <label>Title<input name="title" required maxLength={120} /></label>
        <label>Scope<textarea name="description" required minLength={20} maxLength={4000} rows={5} /></label>
        <label>Timeline (weeks)<input name="timelineWeeks" type="number" min={1} max={104} defaultValue={4} required /></label>
        <label>Team size<input name="teamSize" type="number" min={1} max={100} defaultValue={2} required /></label>
        <label>Systems touched<input name="systemsTouched" type="number" min={1} max={50} defaultValue={1} required /></label>
        <label>New technologies (comma separated)<input name="newTechnologies" /></label>
        <label>External dependencies (comma separated)<input name="externalDependencies" /></label>
        <label>Requirements<select name="requirements" defaultValue="partial"><option value="clear">Clear</option><option value="partial">Partly defined</option><option value="unclear">Unclear</option></select></label>
        <label>Team has the expertise<select name="teamHasExpertise" defaultValue="unknown"><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Not sure</option></select></label>
        <label>Budget justified<select name="budgetJustified" defaultValue="unknown"><option value="yes">Yes</option><option value="no">No</option><option value="unknown">Not sure</option></select></label>
        <label className="check"><input name="compliance" type="checkbox" /> Compliance or legal work</label>
        <label className="check"><input name="legalSignOff" type="checkbox" /> Legal sign-off obtained</label>
        <button type="submit" disabled={busy}>{busy ? "Analysing…" : "Analyse proposal"}</button>
      </form>

      {result && (
        <section aria-live="polite">
          <h2>Elena&apos;s reading</h2>
          <div className="kpis">
            <div className="kpi"><span className="kpi-label">Complexity</span><span className="kpi-value">{result.points} points</span></div>
            <div className="kpi"><span className="kpi-label">Size</span><span className="kpi-value">{result.band}</span></div>
            <div className="kpi"><span className="kpi-label">Chance of success</span><span className="kpi-value">{result.successProbability}%</span></div>
          </div>
          <h3>Risks</h3>
          {result.risks.length === 0 ? <p className="empty">No risks found.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th scope="col">Risk</th><th scope="col">Type</th><th scope="col">Level</th><th scope="col">Why</th></tr></thead>
              <tbody>{result.risks.map(r => <tr key={r.title}><td>{r.title}</td><td>{r.category}</td><td>{SEV[r.severity]}</td><td>{r.detail}</td></tr>)}</tbody>
            </table></div>
          )}
          <h3>Compared with your history</h3>
          <ul>{result.comparison.messages.map(m => <li key={m}>{m}</li>)}</ul>
          <h3>Recommendations</h3>
          <ul>{result.recommendations.map(m => <li key={m}>{m}</li>)}</ul>
          <h3>Feasibility checklist</h3>
          <ul>{result.checklist.map(c => <li key={c.key}>{c.status === "yes" ? "Yes" : c.status === "no" ? "No" : "Not sure"}: {c.label}{c.note ? ` (${c.note})` : ""}</li>)}</ul>
        </section>
      )}

      <h2>Finished projects</h2>
      <p className="muted">Elena compares a proposal with these once there are three. Entries cannot be edited or removed.</p>
      <form onSubmit={addHistory} className="form-grid">
        <label>Name<input name="name" required maxLength={120} /></label>
        <label>Points (1 to 21)<input name="points" type="number" min={1} max={21} required /></label>
        <label>Weeks taken<input name="weeks" type="number" min={1} max={104} required /></label>
        <label>Outcome<select name="outcome" defaultValue="succeeded"><option value="succeeded">Succeeded</option><option value="failed">Failed</option></select></label>
        <button type="submit">Add project</button>
      </form>
      {history.length === 0 ? <p className="empty">No finished projects yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Project</th><th scope="col" className="num">Points</th><th scope="col" className="num">Weeks</th><th scope="col">Outcome</th></tr></thead>
          <tbody>{history.map(h => <tr key={h.id}><td>{h.name}</td><td className="num">{h.points}</td><td className="num">{h.weeks}</td><td>{h.outcome === "failed" ? "Failed" : "Succeeded"}</td></tr>)}</tbody>
        </table></div>
      )}
    </main>
  );
}
