"use client";
import { useCallback, useEffect, useState } from "react";
import "../../../styles/admin.css";
import "../../../styles/feeds.css";
import "../../../styles/leads.css";
import { JSON_HEADERS } from "../../../listings/ui";

type Rule = { id: string; label: string; sourceId: string | null; position: number; enabled: boolean; postcodes: string[]; suburbs: string[]; propertyTypes: string[]; interests: string[]; agentUserIds: string[] };
type Agent = { id: string; name: string };
const TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const INTERESTS = ["buying", "selling", "renting"];
const conditions = (r: Rule) => [r.postcodes.length && `Postcodes ${r.postcodes.join(", ")}`, r.suburbs.length && `Suburbs ${r.suburbs.join(", ")}`,
  r.propertyTypes.length && `Types ${r.propertyTypes.join(", ")}`, r.interests.length && `Interest ${r.interests.join(", ")}`].filter(Boolean).join(" · ");

/** Staff screen for lead routing rules. Rules apply in order; the first match wins and the least busy listed agent gets the lead. leads.manage only. */
export default function LeadRules() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState({ label: "", position: "100", postcodes: "", suburbs: "", propertyTypes: [] as string[], interests: [] as string[], agentUserIds: [] as string[] });

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/lead-rules").catch(() => null);
    if (!r) return setError("Could not load the rules.");
    if (r.status === 401) return setError("Sign in as staff to manage lead routing.");
    if (r.status === 403) return setError("Your role cannot manage ad leads.");
    if (!r.ok) return setError("Could not load the rules.");
    const d = await r.json(); setRules(d.rules); setAgents(d.agents); setError("");
  }, []);
  useEffect(() => { void load(); }, [load]);

  const toggle = (k: "propertyTypes" | "interests" | "agentUserIds", v: string) =>
    setForm(f => ({ ...f, [k]: f[k].includes(v) ? f[k].filter(x => x !== v) : [...f[k], v] }));

  async function act(id: string, action: string) {
    setBusy(id); setError("");
    try {
      const r = await fetch(`/api/staff/lead-rules/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action }) });
      if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "That did not work.");
      await load();
    } finally { setBusy(""); }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy("create"); setError("");
    try {
      const r = await fetch("/api/staff/lead-rules", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ ...form, position: Number(form.position) }) });
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "That did not work."); return; }
      setForm({ ...form, label: "", postcodes: "", suburbs: "", propertyTypes: [], interests: [], agentUserIds: [] }); await load();
    } finally { setBusy(""); }
  }
  const name = (id: string) => agents.find(a => a.id === id)?.name ?? "Unknown agent";

  return (
    <main className="stack">
      <h1>Lead routing</h1>
      <p className="muted">A new lead goes to the first rule below that matches it (lowest order first). With no match it goes to an agent whose profile covers its postcode or suburb, then to the form's default agent, otherwise it waits for staff. Within a rule the agent with the fewest open leads gets it.</p>
      <p><a href="/staff/leads">Back to ad leads</a></p>
      {error && <p className="leads-msg bad" role="alert">{error}</p>}
      {rules === null && !error ? <p className="muted">Loading…</p> : rules && rules.length === 0 ? <p className="empty">No rules yet. Leads use agents' service areas and each form's default agent.</p> : rules && (
        <div className="table-wrap"><table className="leads-table">
          <thead><tr><th className="num">Order</th><th>Rule</th><th>Matches</th><th>Agents</th><th>State</th><th>Actions</th></tr></thead>
          <tbody>{rules.map(r => (
            <tr key={r.id}>
              <td data-label="Order" className="num">{r.position}</td>
              <td data-label="Rule"><strong>{r.label}</strong></td>
              <td data-label="Matches">{conditions(r)}</td>
              <td data-label="Agents">{r.agentUserIds.map(name).join(", ")}</td>
              <td data-label="State"><span className={`status-pill ${r.enabled ? "good" : ""}`}>{r.enabled ? "On" : "Paused"}</span></td>
              <td data-label="Actions"><div className="actions">
                <button type="button" className="secondary" disabled={busy === r.id} onClick={() => act(r.id, r.enabled ? "disable" : "enable")}>{r.enabled ? "Pause" : "Resume"}</button>
                <button type="button" className="secondary" disabled={busy === r.id} onClick={() => act(r.id, "delete")}>Delete</button>
              </div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      <h2>Add a rule</h2>
      <form className="stack feeds-form" onSubmit={create}>
        <div className="feeds-grid">
          <label>Name <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="e.g. Brisbane inner west houses" minLength={2} maxLength={80} required /></label>
          <label>Order (lowest first) <input type="number" min={1} max={10000} value={form.position} onChange={e => setForm({ ...form, position: e.target.value })} /></label>
          <label>Postcodes <input value={form.postcodes} onChange={e => setForm({ ...form, postcodes: e.target.value })} placeholder="4064, 4066" inputMode="numeric" /></label>
          <label>Suburbs <input value={form.suburbs} onChange={e => setForm({ ...form, suburbs: e.target.value })} placeholder="Paddington, Red Hill" /></label>
        </div>
        <fieldset className="leads-checks"><legend>Property types</legend>{TYPES.map(t => <label key={t}><input type="checkbox" checked={form.propertyTypes.includes(t)} onChange={() => toggle("propertyTypes", t)} /> {t}</label>)}</fieldset>
        <fieldset className="leads-checks"><legend>Interest</legend>{INTERESTS.map(t => <label key={t}><input type="checkbox" checked={form.interests.includes(t)} onChange={() => toggle("interests", t)} /> {t}</label>)}</fieldset>
        <fieldset className="leads-checks"><legend>Send to (choose one or more agents)</legend>
          {agents.length === 0 ? <span className="muted">No active agents yet.</span> : agents.map(a => <label key={a.id}><input type="checkbox" checked={form.agentUserIds.includes(a.id)} onChange={() => toggle("agentUserIds", a.id)} /> {a.name}</label>)}
        </fieldset>
        <div><button type="submit" disabled={busy === "create" || form.agentUserIds.length === 0}>{busy === "create" ? "Adding…" : "Add rule"}</button></div>
      </form>
    </main>
  );
}
