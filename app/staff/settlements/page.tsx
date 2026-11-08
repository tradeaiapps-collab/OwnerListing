"use client";
import { useEffect, useState } from "react";
import { STAGE_LABEL, STAGES, STUCK_DAYS, type Stage } from "../../../src/domain/settlement";
import { BAND_LABEL } from "../../settlements/risk-panel";
import { loadError } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/settlement.css";

interface Row { id: string; listingTitle: string; currentStage: Stage; completed: boolean; fellThrough: boolean; stuck: { stuck: boolean; days: number; blocked: boolean }; doneStages: number; totalStages: number; nextTarget: string | null }
interface Portfolio { rows: Row[]; totals: { open: number; stuck: number; completed: number; fellThrough: number }; byStage: Record<string, number> }
interface RiskRow { id: string; listingTitle: string; stage: Stage; score: number; band: "low" | "medium" | "high"; trend: "worse" | "better" | "same"; change: number; primary: string | null; predictedFallthroughDate: string | null }
interface Risk { rows: RiskRow[]; alerts: RiskRow[]; totals: { open: number; high: number; medium: number; low: number }; history: { fellThrough: number; settled: number; ratePercent: number | null; byReason: Record<string, number> } }
const ARROW = { worse: "▲ worse", better: "▼ better", same: "steady" } as const;
const REASON: Record<string, string> = { buyer_backed_out: "Buyer backed out", financing_denied: "Finance denied", inspection_issues: "Inspection issues", other: "Other" };
const Badge = ({ r }: { r: RiskRow }) => <span className={`risk-badge risk-${r.band}`}>{BAND_LABEL[r.band]} · {r.score}</span>;
const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** Portfolio of every settlement. Stuck deals (blocked, or open more than five days) come first. Listing titles only: no buyer or owner details. */
export default function StaffSettlements() {
  const [p, setP] = useState<Portfolio | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/staff/settlements").then(async r => { if (r.ok) setP(await r.json()); else setError(loadError(r.status)); }).catch(() => setError(loadError(0)));
    // Risk is extra: if it fails the portfolio still shows.
    fetch("/api/staff/settlements/risk").then(async r => { if (r.ok) setRisk(await r.json()); }).catch(() => undefined);
  }, []);
  const byId = new Map((risk?.rows ?? []).map(r => [r.id, r]));
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
          {risk && risk.totals.open > 0 && (
            <>
              <h2>At-risk deals</h2>
              <p className="muted">Elena scores each open deal from its dates, inspection findings, offers and checklists. {risk.history.ratePercent != null ? `Historically ${risk.history.ratePercent}% of closed deals fell through (${risk.history.fellThrough} of ${risk.history.fellThrough + risk.history.settled}). ` : ""}Scores are estimates, not decisions.</p>
              <div className="kpis">
                <div className="kpi"><span className="kpi-label">High risk</span><span className="kpi-value">{risk.totals.high}</span></div>
                <div className="kpi"><span className="kpi-label">Medium risk</span><span className="kpi-value">{risk.totals.medium}</span></div>
                <div className="kpi"><span className="kpi-label">Low risk</span><span className="kpi-value">{risk.totals.low}</span></div>
              </div>
              {risk.alerts.length === 0 ? <p className="empty">No deals are at medium or high risk.</p> : (
                <ol className="risk-alerts">
                  {risk.alerts.map(a => (
                    <li key={a.id} className={`risk-${a.band}`}>
                      <Badge r={a} />
                      <a href={`/staff/settlements/${a.id}`}>{a.listingTitle}</a>
                      <span className="risk-trend">{ARROW[a.trend]}{a.trend !== "same" ? ` (${a.change > 0 ? "+" : ""}${a.change})` : ""}</span>
                      <p className="why">{STAGE_LABEL[a.stage]}{a.primary ? `. Main risk: ${a.primary}` : ""}{a.predictedFallthroughDate ? `. Could fall through around ${day(a.predictedFallthroughDate)}` : ""}.</p>
                    </li>
                  ))}
                </ol>
              )}
              {Object.keys(risk.history.byReason).length > 0 && <p className="muted">Why past deals fell through: {Object.entries(risk.history.byReason).map(([k, n]) => `${REASON[k] ?? k} ${n}`).join(" · ")}</p>}
            </>
          )}
          {p.totals.open > 0 && <p className="muted">By stage: {STAGES.filter(s => p.byStage[s]).map(s => `${STAGE_LABEL[s]} ${p.byStage[s]}`).join(" · ")}</p>}
          {p.rows.length === 0 ? <p className="empty">No settlements are being tracked yet.</p> : (
            <div className="table-wrap"><table className="settle-table">
              <thead><tr><th scope="col">Property</th><th scope="col">Stage</th><th scope="col">Status</th><th scope="col">Risk</th><th scope="col" className="num">Progress</th><th scope="col" className="num">Next date</th></tr></thead>
              <tbody>
                {p.rows.map(r => (
                  <tr key={r.id}>
                    <td>{byId.has(r.id) ? <a href={`/staff/settlements/${r.id}`}>{r.listingTitle}</a> : r.listingTitle}</td>
                    <td>{r.fellThrough ? "Closed" : STAGE_LABEL[r.currentStage]}</td>
                    <td>{r.fellThrough ? "Fell through" : r.completed ? "Settled" : r.stuck.blocked ? "Blocked" : r.stuck.stuck ? `Stuck ${r.stuck.days} days` : "On track"}</td>
                    <td>{byId.get(r.id) ? <Badge r={byId.get(r.id)!} /> : "–"}</td>
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
