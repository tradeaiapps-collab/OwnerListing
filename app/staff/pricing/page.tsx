"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/billing.css";
import { JSON_HEADERS } from "../../listings/ui";
import { money } from "../../plans/view";

interface Row { id: string; planId: string; priceCents: number; reason: string; setBy: string; effectiveFrom: string }
const PLANS = [
  ["basic", "Basic (per listing)"], ["standard", "Standard (per listing)"], ["premium", "Premium (per listing)"],
  ["owner_plus", "Owner Plus (per month)"], ["agent_pro", "Agent Pro (per month)"], ["agent_team", "Agent Team (per month)"]
] as const;

export default function StaffPricing() {
  const [current, setCurrent] = useState<Record<string, number>>({});
  const [history, setHistory] = useState<Row[]>([]);
  const [planId, setPlanId] = useState("basic");
  const [dollars, setDollars] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/pricing").catch(() => null);
    if (!r) { setError("Could not load pricing."); return; }
    if (r.status === 401) { setError("Sign in as staff to manage pricing."); return; }
    if (r.status === 403) { setError("Only a super admin can manage pricing."); return; }
    if (!r.ok) { setError("Could not load pricing."); return; }
    const d = await r.json();
    setCurrent(d.current); setHistory(d.history);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(dollars)) { setError("Enter the price in dollars excluding GST, for example 199 or 199.50."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/staff/pricing", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ planId, priceCents: Math.round(Number(dollars) * 100), reason }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setDollars(""); setReason(""); await load(); } else setError(d.error ?? "Could not save the price.");
    } catch {
      setError("Could not save the price.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Plan pricing</h1>
      <p className="muted">Prices exclude GST. Saving adds a new price with a reason; earlier prices stay in the history, and invoices already issued keep their price.</p>
      <ul className="card-list">
        {PLANS.map(([id, name]) => <li key={id}><strong>{name}</strong>: {current[id] === undefined ? "price not set" : `${money(current[id])} excl. GST`}</li>)}
      </ul>
      <form className="stack" onSubmit={onSave}>
        <label>Plan <select value={planId} onChange={e => setPlanId(e.target.value)}>{PLANS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>New price in dollars, excluding GST <input inputMode="decimal" value={dollars} onChange={e => setDollars(e.target.value)} required /></label>
        <label>Reason <textarea value={reason} onChange={e => setReason(e.target.value)} minLength={5} maxLength={500} required /></label>
        <button type="submit" disabled={busy}>{busy ? "Saving..." : "Set price"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <h2>History</h2>
      {history.length === 0 ? <p className="empty">No prices have been set.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Plan</th><th>Price excl. GST</th><th>Set by</th><th>Reason</th></tr></thead>
          <tbody>{history.map(h => (
            <tr key={h.id}><td>{new Date(h.effectiveFrom).toLocaleString()}</td><td>{h.planId}</td><td>{money(h.priceCents)}</td><td>{h.setBy}</td><td>{h.reason}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </main>
  );
}
