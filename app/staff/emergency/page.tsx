"use client";
import { useEffect, useState } from "react";
import { loadError } from "../staff-api";
import "../../styles/agent-performance.css";

type Row = { id: string; number: number; jobNumber: number | null; status: string; trade: string; suburb: string | null; postcode: string | null; propertyKind: string; description: string; createdAt: string; round: number; asked: number; delivered: number; declined: number; accepted: number; requester: string };
type Log = { channel: string; status: string; errorCode: string | null; at: string };
const STATUS: Record<string, string> = { open: "Open", accepted: "Accepted", cancelled: "Cancelled", expired: "No answer" };
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
const label = (t: string) => t.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

/** Urgent requests sent to emergency contractors, how far each got, and the email and text log for them. */
export default function StaffEmergency() {
  const [data, setData] = useState<{ requests: Row[]; outbox: Log[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/staff/emergency").catch(() => null);
      if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
      setData(await r.json());
    })();
  }, []);
  const n = (f: (r: Row) => boolean) => (data?.requests ?? []).filter(f).length;
  const sent = (data?.outbox ?? []).filter(o => o.status === "sent").length;
  return (
    <main className="admin-page ap">
      <div>
        <h1>Emergency requests</h1>
        <p className="ap-lead">Urgent requests Elena sent to emergency contractors. Street addresses, phone numbers and email addresses are not shown here.</p>
      </div>
      {error && <p role="alert" className="ap-error">{error}</p>}
      {!data && !error && <p className="ap-state" role="status">Loading…</p>}
      {data && (
        <>
          <div className="ap-kpis">
            <div className="ap-kpi"><span>Requests</span><strong>{data.requests.length}</strong></div>
            <div className="ap-kpi"><span>Accepted</span><strong>{n(r => r.status === "accepted")}</strong></div>
            <div className="ap-kpi"><span>No answer</span><strong>{n(r => r.status === "expired")}</strong></div>
            <div className="ap-kpi"><span>Emails and texts sent</span><strong>{sent}</strong></div>
          </div>
          <h2>Requests</h2>
          {data.requests.length === 0 ? <div className="ap-state">No urgent requests yet.</div> : (
            <div className="ap-table-wrap">
              <table className="ap-table">
                <caption className="sr-only">Urgent requests with the number of contractors asked, reached, declined and accepted</caption>
                <thead><tr>
                  <th scope="col">Request</th><th scope="col">Trade and area</th><th scope="col">Status</th><th scope="col" className="num">Round</th>
                  <th scope="col" className="num">Asked</th><th scope="col" className="num">Reached</th><th scope="col" className="num">Declined</th><th scope="col" className="num">Accepted</th>
                </tr></thead>
                <tbody>
                  {data.requests.map(r => (
                    <tr key={r.id}>
                      <td className="agent">{r.jobNumber ? `JOB-${r.jobNumber}` : `EMG-${r.number}`}<small>{r.requester} · {when(r.createdAt)}</small></td>
                      <td className="agent">{label(r.trade)}<small>{[r.suburb, r.postcode].filter(Boolean).join(" ")} · {r.propertyKind}</small></td>
                      <td>{STATUS[r.status] ?? r.status}</td>
                      <td className="num">{r.round}</td><td className="num">{r.asked}</td><td className="num">{r.delivered}</td><td className="num">{r.declined}</td><td className="num">{r.accepted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2>Email and text log</h2>
          {data.outbox.length === 0 ? <div className="ap-state">Nothing has been sent yet.</div> : (
            <div className="ap-table-wrap">
              <table className="ap-table">
                <caption className="sr-only">Newest emergency emails and texts with their result</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">Channel</th><th scope="col">Result</th><th scope="col">Error code</th></tr></thead>
                <tbody>{data.outbox.map((o, i) => <tr key={i}><td>{when(o.at)}</td><td>{o.channel === "sms" ? "Text" : "Email"}</td><td>{o.status === "not_configured" ? "Not set up" : label(o.status)}</td><td>{o.errorCode ?? "–"}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <ul className="ap-notes"><li>A request widens to more contractors after 15 minutes with no answer, up to 3 rounds. Outside delivery needs email and text set up on the Messaging page.</li></ul>
        </>
      )}
    </main>
  );
}
