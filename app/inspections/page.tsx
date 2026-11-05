"use client";
import { useEffect, useState } from "react";
import { formatWhen, ROLE_LABELS, STATUS_LABELS, TYPE_LABELS } from "./ui";

type Row = {
  id: string; listingId: string; listingTitle: string; type: string; scheduledAt: string; status: string; role: string;
  counterpartName: string; openFollowUps: number; criticalCount: number;
};

export default function MyInspections() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "followups">("all");

  useEffect(() => {
    fetch("/api/inspections").then(async r => {
      const d = await r.json().catch(() => ({}));
      if (r.ok) setRows(d.inspections);
      else setError(r.status === 401 ? "Sign in to see your inspections." : d.error ?? "Could not load inspections.");
    }).catch(() => setError("Could not load inspections."));
  }, []);

  const shown = rows?.filter(r => filter === "all" || r.openFollowUps > 0) ?? [];
  const followUps = rows?.reduce((n, r) => n + r.openFollowUps, 0) ?? 0;

  return (
    <main className="insp-page">
      <h1>Inspections</h1>
      <p className="muted">Bookings you made, jobs you were invited to, and reports shared with you.</p>
      {error && <p role="alert">{error}</p>}
      {!error && rows === null && <p className="muted" role="status">Loading…</p>}
      {rows && (
        <div className="actions" role="group" aria-label="Filter">
          <button type="button" className={filter === "all" ? "" : "secondary"} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All ({rows.length})</button>
          <button type="button" className={filter === "followups" ? "" : "secondary"} aria-pressed={filter === "followups"} onClick={() => setFilter("followups")}>Open follow-ups ({followUps})</button>
        </div>
      )}
      {rows && shown.length === 0 && <p className="empty">{rows.length === 0 ? "No inspections yet. Owners can book one from a listing's Inspections page." : "No open follow-ups."}</p>}
      <ul className="card-list insp-list">
        {shown.map(r => (
          <li key={r.id}>
            <div className="top">
              <strong>{r.listingTitle}</strong>
              <span className="badge">{STATUS_LABELS[r.status] ?? r.status}</span>
              {r.criticalCount > 0 && <span className="insp-sev sev-critical">{r.criticalCount} critical</span>}
            </div>
            <span>{TYPE_LABELS[r.type] ?? r.type} · {formatWhen(r.scheduledAt)}</span>
            <span className="muted">{ROLE_LABELS[r.role]} · {r.role === "inspector" ? "Owner" : "Inspector"}: {r.counterpartName}{r.openFollowUps > 0 ? ` · ${r.openFollowUps} open follow-up${r.openFollowUps === 1 ? "" : "s"}` : ""}</span>
            <div className="actions"><a className="button" href={`/inspections/${r.id}`}>{r.role === "inspector" && (r.status === "invited" || r.status === "accepted") ? "Open job" : "Open report"}</a></div>
          </li>
        ))}
      </ul>
    </main>
  );
}
