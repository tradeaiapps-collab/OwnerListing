"use client";
import { useCallback, useEffect, useState } from "react";
import { aud, HEALTH_LABEL, STATUS_LABEL, type HealthInfo, PROJECT_STATUSES } from "../../../src/domain/staff-project";
import { loadError, postStaff } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/projects.css";

interface Card { id: string; title: string; goal: string; status: string; ownerName: string; memberNames: string[]; endDate: string; budgetCents: number; health: HealthInfo; escalatedAt: string | null; prs: { merged: number; open: number; total: number }; featureLine: string; riskCount: number }
interface Data { projects: Card[]; people: { id: string; name: string }[]; settings: { highBudgetCents: number }; can: { propose: boolean; configure: boolean } }

/** Every internal project as a status card: waiting for approval first, then stuck, blocked and at risk. */
export default function StaffProjects() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [f, setF] = useState({ status: "", owner: "", goal: "" });
  const [threshold, setThreshold] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const q = new URLSearchParams(); if (f.status) q.set("status", f.status); if (f.owner) q.set("owner", f.owner); if (f.goal.trim()) q.set("goal", f.goal.trim());
    const r = await fetch(`/api/staff/projects?${q}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const j: Data = await r.json(); setError(""); setD(j); setThreshold(String(j.settings.highBudgetCents / 100));
  }, [f]);
  useEffect(() => { void load(); }, [load]);
  async function saveThreshold(e: React.FormEvent) {
    e.preventDefault();
    const res = await postStaff("/api/staff/projects", { action: "set_threshold", highBudgetDollars: Number(threshold) });
    setMessage(res.ok ? "Threshold saved." : String(res.data["error"] ?? "Could not save.")); if (res.ok) await load();
  }
  const count = (s: string) => d?.projects.filter(p => p.status === s).length ?? 0;
  return (
    <main className="admin-page">
      <h1>Internal projects</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">Proposals need a tech lead sign-off and a stakeholder approval before they go active. An active project with no progress for more than 5 days is escalated to the CTO.</p>
      {d?.can.propose && <p><a className="button" href="/staff/projects/new">Create project</a></p>}
      {error && <p role="alert">{error}</p>}
      {!error && !d && <p className="muted" role="status">Loading…</p>}
      {d && (
        <>
          <div className="kpis">
            <div className="kpi"><span className="kpi-label">Waiting for approval</span><span className="kpi-value">{count("pending_approval")}</span></div>
            <div className="kpi"><span className="kpi-label">Active</span><span className="kpi-value">{count("active")}</span></div>
            <div className="kpi"><span className="kpi-label">On hold</span><span className="kpi-value">{count("on_hold")}</span></div>
            <div className="kpi"><span className="kpi-label">Completed</span><span className="kpi-value">{count("completed")}</span></div>
          </div>
          <div className="proj-filters">
            <label>Status<select value={f.status} onChange={e => setF({ ...f, status: e.target.value })}><option value="">All</option>{PROJECT_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
            <label>Owner<select value={f.owner} onChange={e => setF({ ...f, owner: e.target.value })}><option value="">Anyone</option>{d.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Goal contains<input value={f.goal} maxLength={100} onChange={e => setF({ ...f, goal: e.target.value })} /></label>
          </div>
          {d.projects.length === 0 ? <p className="empty">No projects match. {d.can.propose ? "Create the first one." : ""}</p> : (
            <ul className="proj-grid">
              {d.projects.map(p => {
                const live = p.status === "active", tone = p.status === "pending_approval" ? "waiting" : live ? p.health.health : "";
                return (
                  <li key={p.id} className={`proj-card is-${tone}`}>
                    <h2><a href={`/staff/projects/${p.id}`}>{p.title}</a></h2>
                    <span className={`proj-status ${live ? p.health.health : ""}`}>{live ? HEALTH_LABEL[p.health.health] : STATUS_LABEL[p.status as keyof typeof STATUS_LABEL]}{p.escalatedAt && live ? " · sent to CTO" : ""}</span>
                    <p className="proj-meta">Goal: {p.goal}</p>
                    <p className="proj-meta">Owner {p.ownerName}{p.memberNames.length ? ` · team ${p.memberNames.join(", ")}` : ""}</p>
                    {live && <div className="proj-meter"><progress max={100} value={p.health.progress} aria-label="Milestones done" /><span>{p.health.progress}%</span></div>}
                    <p className="proj-meta">{live ? `${p.health.daysRemaining >= 0 ? `${p.health.daysRemaining} days left` : `${-p.health.daysRemaining} days late`} of ${p.health.plannedDays} planned` : `Ends ${p.endDate}`} · {aud(p.budgetCents)}</p>
                    {live && <p className="proj-meta">Next: {p.health.nextMilestone ? `${p.health.nextMilestone.description} (${p.health.nextMilestone.targetDate})` : "no milestone set"}</p>}
                    {live && p.health.reasons.length > 0 && <ul className="proj-reasons">{p.health.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
                    <p className="proj-meta">{p.featureLine} · PRs: {p.prs.merged} merged, {p.prs.open} open{p.riskCount ? ` · ${p.riskCount} risk flag${p.riskCount === 1 ? "" : "s"}` : ""}</p>
                  </li>
                );
              })}
            </ul>
          )}
          {d.can.configure && (
            <form className="proj-inline" onSubmit={saveThreshold}>
              <label>High budget threshold (AUD)<input type="number" min={1} step={1} value={threshold} onChange={e => setThreshold(e.target.value)} /></label>
              <button type="submit">Save</button>
              {message && <span role="status">{message}</span>}
            </form>
          )}
        </>
      )}
    </main>
  );
}
