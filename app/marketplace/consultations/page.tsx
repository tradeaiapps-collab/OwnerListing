"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/agent-marketplace.css";
import { whenLabel } from "../agents/ui";

type Row = { id: string; role: "client" | "agent"; counterpart: string; agentId: string; startsAt: string; endsAt: string; mode: string; status: string; videoUrl?: string; phone?: string; note?: string; timezone: string };

/** The signed-in user's consultations: join link for video, number to call for phone, cancel while still in the future. */
export default function ConsultationsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/marketplace/consultations");
      if (r.status === 401) return setError("Sign in to see your consultations.");
      if (!r.ok) throw new Error();
      setRows((await r.json()).consultations);
    } catch { setError("Could not load your consultations."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function cancel(id: string) {
    if (!window.confirm("Cancel this consultation? The other person is told.")) return;
    setBusyId(id); setMsg("");
    try {
      const r = await fetch(`/api/marketplace/consultations/${id}`, { method: "DELETE", headers: { "content-type": "application/json" } });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok ? "Consultation cancelled." : d.error ?? "Could not cancel.");
      await load();
    } catch { setMsg("Could not cancel."); } finally { setBusyId(""); }
  }

  const now = Date.now();
  const upcoming = (rows ?? []).filter(r => r.status === "confirmed" && Date.parse(r.endsAt) > now).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = (rows ?? []).filter(r => !upcoming.includes(r));
  const item = (r: Row, canCancel: boolean) => (
    <li key={r.id} data-status={r.status}>
      <strong>{whenLabel(r.startsAt, r.timezone)}</strong>
      <span>{r.role === "client" ? <>With <a href={`/marketplace/agents/${r.agentId}`}>{r.counterpart}</a></> : <>Client: {r.counterpart}</>} · {r.mode === "video" ? "Video call" : "Phone call"}{r.status === "cancelled" ? " · Cancelled" : ""}</span>
      {r.videoUrl && <a className="button" href={r.videoUrl} target="_blank" rel="noopener noreferrer">Join video call</a>}
      {r.phone && <span>Call <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}>{r.phone}</a></span>}
      {r.note && <span className="muted">“{r.note}”</span>}
      {canCancel && <div className="actions" style={{ margin: 0 }}><button type="button" className="secondary" disabled={busyId === r.id} onClick={() => cancel(r.id)}>{busyId === r.id ? "Cancelling…" : "Cancel"}</button></div>}
    </li>
  );

  return (
    <main className="ma">
      <div><h1>My consultations</h1><p className="muted">Times are shown in the agent&apos;s timezone.</p></div>
      {error && <p role="alert" className="ma-error">{error} {error.startsWith("Sign in") && <a href="/login?as=buyer">Sign in</a>}</p>}
      {msg && <p role="status" className="ma-ok">{msg}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && (
        <>
          <section className="ma-section" aria-labelledby="up-h"><h2 id="up-h">Upcoming</h2>
            {upcoming.length === 0 ? <div className="ma-state"><p>Nothing booked.</p><p><a className="button" href="/marketplace/agents">Find an agent</a></p></div> : <ul className="ma-consults">{upcoming.map(r => item(r, true))}</ul>}
          </section>
          {past.length > 0 && <section className="ma-section" aria-labelledby="past-h"><h2 id="past-h">Recent and cancelled</h2><ul className="ma-consults">{past.map(r => item(r, false))}</ul></section>}
        </>
      )}
    </main>
  );
}
