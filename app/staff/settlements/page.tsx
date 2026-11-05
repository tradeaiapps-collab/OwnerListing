"use client";
import { useEffect, useState } from "react";
import { STAGE_LABEL, STAGES, STUCK_DAYS, type Stage } from "../../../src/domain/settlement";
import { loadError } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/settlement.css";

interface Row { id: string; listingTitle: string; currentStage: Stage; completed: boolean; fellThrough: boolean; stuck: { stuck: boolean; days: number; blocked: boolean }; doneStages: number; totalStages: number; nextTarget: string | null }
interface Portfolio { rows: Row[]; totals: { open: number; stuck: number; completed: number; fellThrough: number }; byStage: Record<string, number> }
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** Portfolio of every settlement. Stuck deals (blocked, or open more than five days) come first. Listing titles only: no buyer or owner details. */
export default function StaffSettlements() {
  const [p, setP] = useState<Portfolio | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/staff/settlements").then(async r => { if (r.ok) setP(await r.json()); else setError(loadError(r.status)); }).catch(() => setError(loadError(0)));
  }, []);
  return (
    <main className="admin-page">
      <h1>Settlements</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">Every accepted offer being tracked to settlement. A deal is flagged when its open stage is blocked or has sat for more than {STUCK_DAYS} days.</p>
      {error && <p role="alert">{error}</p>}
      {!error && !p && <p className="muted" role="status">Loading…</p>}
      {p && (
        <>
          <div className="kpis">
            <div className="kpi"><span className="kpi-label">In progress</span><span className="kpi-value">{p.totals.open}</span></div>
            <div className="kpi"><span className="kpi-label">Stuck</span><span className="kpi-value">{p.totals.stuck}</span></div>
            <div className="kpi"><span className="kpi-label">Settled</span><span className="kpi-value">{p.totals.completed}</span></div>
            <div className="kpi"><span className="kpi-label">Fell through</span><span className="kpi-value">{p.totals.fellThrough}</span></div>
          </div>
          {p.totals.open > 0 && <p className="muted">By stage: {STAGES.filter(s => p.byStage[s]).map(s => `${STAGE_LABEL[s]} ${p.byStage[s]}`).join(" · ")}</p>}
          {p.rows.length === 0 ? <p className="empty">No settlements are being tracked yet.</p> : (
            <div className="table-wrap"><table className="settle-table">
              <thead><tr><th scope="col">Property</th><th scope="col">Stage</th><th scope="col">Status</th><th scope="col" className="num">Progress</th><th scope="col" className="num">Next date</th></tr></thead>
              <tbody>
                {p.rows.map(r => (
                  <tr key={r.id}>
                    <td>{r.listingTitle}</td>
                    <td>{r.fellThrough ? "Closed" : STAGE_LABEL[r.currentStage]}</td>
                    <td>{r.fellThrough ? "Fell through" : r.completed ? "Settled" : r.stuck.blocked ? "Blocked" : r.stuck.stuck ? `Stuck ${r.stuck.days} days` : "On track"}</td>
                    <td className="num">{r.doneStages} of {r.totalStages}</td>
                    <td className="num">{r.nextTarget && !r.completed && !r.fellThrough ? day(r.nextTarget) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </>
      )}
    </main>
  );
}
