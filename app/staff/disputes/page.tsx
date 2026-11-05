"use client";
import { useCallback, useEffect, useState } from "react";
import { ESCALATION_LABEL, STATUS_LABEL, TYPE_LABEL } from "../../../src/domain/dispute";
import { DisputeDetail, day, type Detail, type Summary } from "../../disputes/dispute-parts";
import { loadError } from "../staff-api";
import "../../styles/admin.css";

interface Row extends Summary { claimed: boolean; ageDays: number }
interface Metrics { total: number; open: number; agreedByParties: number; resolvedByStaff: number; withdrawn: number; mediationSuccessPct: number | null; afterMediation: { settled: number; fellThrough: number; inProgress: number; settledPct: number | null } }
const pct = (n: number | null) => (n === null ? "–" : `${n}%`);

/** Staff mediation centre: disputes Elena and the two sides could not settle come first. Staff record the outcome; they never move money here. */
export default function StaffDisputes() {
  const [q, setQ] = useState<{ rows: Row[]; metrics: Metrics } | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(""), [outcome, setOutcome] = useState(""), [share, setShare] = useState("");

  const load = useCallback(async (openId?: string) => {
    const r = await fetch("/api/staff/disputes").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setQ(await r.json()); setError("");
    if (openId) { const d = await fetch(`/api/staff/disputes/${openId}`).catch(() => null); if (d?.ok) setOpen(await d.json()); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(true); setError("");
    const r = await fetch(`/api/staff/disputes/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (r && !r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.");
    else if (!r) setError("Network error.");
    else { setNote(""); setOutcome(""); setShare(""); }
    setBusy(false);
    await load(id);
  }

  const m = q?.metrics;
  const sharePct = share.trim() === "" ? null : Number(share), badShare = sharePct !== null && !(Number.isInteger(sharePct) && sharePct >= 0 && sharePct <= 100);
  return (
    <main className="admin-page">
      <h1>Disputes</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">Buyer-seller disputes during settlement. Elena mediates first; a dispute lands here after three rounds, when a side asks, or after five days.</p>
      {error ? <p role="alert">{error}</p> : null}
      {!error && !q ? <p className="muted" role="status">Loading…</p> : null}
      {m ? (
        <div className="kpis">
          <div className="kpi"><span className="kpi-label">Open</span><span className="kpi-value">{m.open}</span></div>
          <div className="kpi"><span className="kpi-label">Settled by the sides</span><span className="kpi-value">{pct(m.mediationSuccessPct)}</span></div>
          <div className="kpi"><span className="kpi-label">Sales that settled after a dispute</span><span className="kpi-value">{pct(m.afterMediation.settledPct)}</span></div>
          <div className="kpi"><span className="kpi-label">Fell through after a dispute</span><span className="kpi-value">{m.afterMediation.fellThrough}</span></div>
        </div>
      ) : null}
      {q && q.rows.length === 0 ? <p className="empty">No disputes yet.</p> : null}
      {q && q.rows.length > 0 ? (
        <div className="table-wrap"><table className="dsp-table">
          <thead><tr><th scope="col">Dispute</th><th scope="col">Property</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col" className="num">Age</th><th scope="col" className="num">Action</th></tr></thead>
          <tbody>
            {q.rows.map(r => (
              <tr key={r.id}>
                <td>{r.title}</td><td>{r.listingTitle}</td><td>{TYPE_LABEL[r.type]}</td>
                <td>{STATUS_LABEL[r.status]}{r.escalationReason ? ` (${ESCALATION_LABEL[r.escalationReason]})` : ""}{r.claimed ? " · claimed" : ""}</td>
                <td className="num">{r.ageDays} {r.ageDays === 1 ? "day" : "days"}</td>
                <td className="num"><button type="button" className="secondary" onClick={() => void load(r.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
      {open ? (
        <DisputeDetail d={open} busy={busy} staff={open.status === "escalated" ? (
          <form className="dsp-respond" onSubmit={e => { e.preventDefault(); }}>
            <h3>Staff actions</h3>
            <div className="dsp-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void act(open.id, { action: "claim" })}>Claim this dispute</button></div>
            <label>Note<textarea rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
            <div className="dsp-actions"><button type="button" className="secondary" disabled={busy || !note.trim()} onClick={() => void act(open.id, { action: "note", note })}>Add note</button></div>
            <label>How it ends (shown to both sides)<textarea rows={3} maxLength={2000} value={outcome} onChange={e => setOutcome(e.target.value)} /></label>
            {open.claimCents !== null ? <label>Share the seller covers (0 to 100, optional)<input type="number" min={0} max={100} step={1} value={share} onChange={e => setShare(e.target.value)} /></label> : null}
            <div className="dsp-actions"><button type="button" disabled={busy || !outcome.trim() || badShare} onClick={() => void act(open.id, { action: "resolve", outcome, sellerSharePct: open.claimCents !== null ? sharePct : null })}>Record the outcome</button></div>
            <p className="dsp-note">Recording an outcome tells both sides. It does not move any money; deposits stay with the solicitor's trust account process. Opened {day(open.createdAt)}.</p>
          </form>
        ) : undefined} />
      ) : null}
    </main>
  );
}
