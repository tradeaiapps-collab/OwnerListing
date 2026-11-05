"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/admin.css";
import "../../styles/feeds.css";
import "../../styles/leads.css";
import { JSON_HEADERS } from "../../listings/ui";

type Row = {
  id: string; sourceLabel: string; name: string | null; email: string | null; phone: string | null; interest: string | null; suburb: string | null; postcode: string | null;
  propertyType: string | null; campaign: string | null; status: string; lostReason: string | null; assignmentDetail: string | null; stage: string; receivedAt: string;
};
const STATUS: Record<string, string> = { new: "New", contacted: "Contacted", qualified: "Qualified", lost: "Lost" };
const TONE: Record<string, string> = { new: "warn", contacted: "", qualified: "good", lost: "bad" };
const when = (s: string) => new Date(s).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Brisbane" });
const PAGE = 50;

/** The signed-in agent's own ad leads: who asked, where, which campaign, and why it was routed to them. They move it along; staff see the same status. */
export default function AgentLeads() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [lost, setLost] = useState<{ id: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ offset: String(offset) });
    if (status) q.set("status", status);
    const r = await fetch(`/api/agent/leads?${q}`).catch(() => null);
    if (!r) return setError("Could not load your leads.");
    if (r.status === 401) return setError("Sign in to see your leads.");
    if (r.status === 403) return setError("Ad leads are for agent accounts.");
    if (!r.ok) return setError("Could not load your leads.");
    const d = await r.json();
    setRows(d.leads); setTotal(d.total); setError("");
  }, [status, offset]);
  useEffect(() => { void load(); }, [load]);

  async function move(id: string, next: string, reason = "") {
    setBusy(id); setError("");
    try {
      const r = await fetch(`/api/agent/leads/${id}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ status: next, reason }) });
      if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "That did not work."); return; }
      setLost(null); await load();
    } finally { setBusy(""); }
  }

  return (
    <main className="stack">
      <h1>My leads</h1>
      <p className="muted">People who filled in one of our Facebook, Instagram or Google ad forms and were sent to you. Contact them soon; leads cool quickly.</p>
      <p><a href="/agent/listings">Back to my listings</a></p>
      {error && <p className="leads-msg bad" role="alert">{error}</p>}
      <label className="leads-range">Show <select value={status} onChange={e => { setStatus(e.target.value); setOffset(0); }}>
        <option value="">All</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select></label>

      {lost && (
        <form className="leads-lost" onSubmit={e => { e.preventDefault(); void move(lost.id, "lost", lost.reason); }}>
          <label>Why was this lead lost? <input value={lost.reason} onChange={e => setLost({ ...lost, reason: e.target.value })} maxLength={300} required /></label>
          <div><button type="submit" disabled={!!busy}>Mark lost</button> <button type="button" className="secondary" onClick={() => setLost(null)}>Cancel</button></div>
        </form>
      )}

      {rows === null && !error ? <p className="muted">Loading…</p> : rows && rows.length === 0 ? (
        <p className="empty">No leads {status ? `with status "${STATUS[status]}"` : "yet"}. New ones appear here as soon as they come in.</p>
      ) : rows && (
        <div className="table-wrap"><table className="leads-table">
          <thead><tr><th>Received</th><th>Lead</th><th>Looking for</th><th>Campaign</th><th>Routed because</th><th>Status</th><th>Move to</th></tr></thead>
          <tbody>{rows.map(l => (
            <tr key={l.id}>
              <td data-label="Received">{when(l.receivedAt)}</td>
              <td data-label="Lead"><strong>{l.name ?? "No name"}</strong>
                {l.phone && <div><a href={`tel:${l.phone}`}>{l.phone}</a></div>}
                {l.email && <div><a href={`mailto:${l.email}`}>{l.email}</a></div>}</td>
              <td data-label="Looking for">{[l.interest, l.propertyType, [l.suburb, l.postcode].filter(Boolean).join(" ")].filter(Boolean).join(" · ") || "—"}</td>
              <td data-label="Campaign">{l.campaign ?? "—"}<div><small className="muted">{l.sourceLabel}</small></div></td>
              <td data-label="Routed because">{l.assignmentDetail ?? "—"}</td>
              <td data-label="Status"><span className={`status-pill ${TONE[l.status] ?? ""}`}>{STATUS[l.status] ?? l.status}</span>{l.lostReason && <div><small>{l.lostReason}</small></div>}</td>
              <td data-label="Move to"><div className="actions">{Object.entries(STATUS).filter(([k]) => k !== l.status).map(([k, v]) => (
                <button key={k} type="button" className="secondary" disabled={busy === l.id} onClick={() => (k === "lost" ? setLost({ id: l.id, reason: "" }) : move(l.id, k))}>{v}</button>
              ))}</div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {total > PAGE && (
        <div className="leads-pager">
          <button type="button" className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
          <span>{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
          <button type="button" className="secondary" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Older</button>
        </div>
      )}
    </main>
  );
}
