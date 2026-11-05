"use client";
import { useEffect, useState } from "react";
import { CHECKLIST_ITEMS, STORY_POINTS, computeRisks, aud, type Checklist, type RiskFlag } from "../../../../src/domain/staff-project";
import { loadError, postStaff } from "../../staff-api";
import "../../../styles/admin.css";
import "../../../styles/projects.css";

const today = () => new Date().toISOString().slice(0, 10);

/** Proposal form. The risk flags update as the form is filled in; the server recomputes them on submit. */
export default function NewProject() {
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [threshold, setThreshold] = useState(5_000_000);
  const [error, setError] = useState("");
  const [f, setF] = useState({ title: "", description: "", goal: "", ownerId: "", memberIds: [] as string[], startDate: today(), endDate: "", budgetDollars: "0", storyPoints: 5, estimatedHours: "40", estimatedDays: "10", teamSize: "2", systemsAffected: "1", usesNewTech: false, assumptions: "", unknowns: "" });
  const [checklist, setChecklist] = useState<Checklist>({ scope_clear: false, dependencies_identified: false, resources_available: false, budget_justified: false, effort_estimated: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/staff/projects").then(async r => { if (!r.ok) { setError(loadError(r.status)); return; } const j = await r.json(); setPeople(j.people); setThreshold(j.settings.highBudgetCents); if (!j.can.propose) setError("Your role cannot propose projects."); }).catch(() => setError(loadError(0)));
  }, []);
  const body = () => ({ ...f, budgetDollars: Number(f.budgetDollars), estimatedHours: Number(f.estimatedHours), estimatedDays: Number(f.estimatedDays), teamSize: Number(f.teamSize), systemsAffected: Number(f.systemsAffected), checklist });
  const risks: RiskFlag[] = f.endDate && f.endDate > f.startDate
    ? computeRisks({ startDate: f.startDate, endDate: f.endDate, budgetCents: Math.round(Number(f.budgetDollars) * 100) || 0, estimatedHours: Number(f.estimatedHours) || 0, systemsAffected: Number(f.systemsAffected) || 1, usesNewTech: f.usesNewTech, storyPoints: f.storyPoints }, threshold)
    : [];
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    const res = await postStaff("/api/staff/projects", body());
    setBusy(false);
    if (res.ok) window.location.href = `/staff/projects/${res.data["id"]}`; else setError(String(res.data["error"] ?? "Could not submit."));
  }
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(s => ({ ...s, [k]: v }));
  return (
    <main className="admin-page">
      <h1>Propose a project</h1>
      <p><a href="/staff/projects">Back to projects</a></p>
      <form className="proj-form" onSubmit={submit}>
        <fieldset><legend>What and why</legend>
          <label>Title<input required minLength={3} maxLength={120} value={f.title} onChange={e => set("title", e.target.value)} /></label>
          <label>Description<textarea required minLength={10} maxLength={4000} rows={4} value={f.description} onChange={e => set("description", e.target.value)} /></label>
          <label>Strategic goal<input required maxLength={500} value={f.goal} onChange={e => set("goal", e.target.value)} placeholder="For example: reduce sales that fall through" /></label>
        </fieldset>
        <fieldset><legend>People</legend>
          <label>Owner<select required value={f.ownerId} onChange={e => set("ownerId", e.target.value)}><option value="">Choose…</option>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label>Team members<select multiple size={Math.min(6, Math.max(3, people.length))} value={f.memberIds} onChange={e => set("memberIds", [...e.target.selectedOptions].map(o => o.value))}>{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </fieldset>
        <fieldset><legend>Timeline and budget</legend>
          <div className="row">
            <label>Start<input type="date" required value={f.startDate} onChange={e => set("startDate", e.target.value)} /></label>
            <label>End<input type="date" required min={f.startDate} value={f.endDate} onChange={e => set("endDate", e.target.value)} /></label>
          </div>
          <label>Budget (AUD)<input type="number" required min={0} step={1} value={f.budgetDollars} onChange={e => set("budgetDollars", e.target.value)} /></label>
        </fieldset>
        <fieldset><legend>Effort</legend>
          <div className="row">
            <label>Story points<select value={f.storyPoints} onChange={e => set("storyPoints", Number(e.target.value))}>{STORY_POINTS.map(n => <option key={n} value={n}>{n}</option>)}</select></label>
            <label>Estimated hours<input type="number" required min={1} value={f.estimatedHours} onChange={e => set("estimatedHours", e.target.value)} /></label>
            <label>Estimated days<input type="number" required min={1} value={f.estimatedDays} onChange={e => set("estimatedDays", e.target.value)} /></label>
            <label>Team size needed<input type="number" required min={1} value={f.teamSize} onChange={e => set("teamSize", e.target.value)} /></label>
            <label>Systems affected<input type="number" required min={1} max={50} value={f.systemsAffected} onChange={e => set("systemsAffected", e.target.value)} /></label>
          </div>
          <label className="check"><input type="checkbox" checked={f.usesNewTech} onChange={e => set("usesNewTech", e.target.checked)} />Uses new technology (new external API, language or framework)</label>
          <label>Assumptions<textarea maxLength={2000} rows={3} value={f.assumptions} onChange={e => set("assumptions", e.target.value)} /></label>
          <label>Unknowns<textarea maxLength={2000} rows={3} value={f.unknowns} onChange={e => set("unknowns", e.target.value)} /></label>
        </fieldset>
        <fieldset><legend>Feasibility checklist</legend>
          {CHECKLIST_ITEMS.map(i => <label key={i.key} className="check"><input type="checkbox" checked={checklist[i.key]} onChange={e => setChecklist({ ...checklist, [i.key]: e.target.checked })} />{i.label}</label>)}
        </fieldset>
        <section aria-live="polite"><h2>Risk flags</h2>
          {risks.length === 0 ? <p className="muted">{f.endDate ? "No risk flags from what you have entered." : "Pick an end date to see the flags."}</p> : <ul className="proj-risks">{risks.map(r => <li key={r.type} className={r.severity}><strong>{r.type.replace(/_/g, " ")}</strong> ({r.severity}): {r.description}</li>)}</ul>}
          <p className="muted">High budget means over {aud(threshold)}. Flags do not block a proposal; reviewers see them.</p>
        </section>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for approval"}</button>
      </form>
    </main>
  );
}
