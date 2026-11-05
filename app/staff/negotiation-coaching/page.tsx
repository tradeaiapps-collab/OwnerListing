"use client";
import { useEffect, useState } from "react";
import { loadError } from "../staff-api";
import "../../styles/admin.css";
import "../../styles/settlement.css";

interface Group { deals: number; settled: number; fellThrough: number; avgDaysToSettle: number | null }
interface Stats { byType: { type: string; shown: number; used: number; dismissed: number; settled: number; fellThrough: number }[]; coached: Group; uncoached: Group }
const LABEL: Record<string, string> = {
  inspection_waived: "Inspection waived", inspection_window_short: "Inspection window short", settlement_too_short: "Settlement too short", settlement_long: "Settlement long",
  finance_unverified: "Finance not verified", finance_timeline_tight: "Finance timeline tight", deposit_low: "Deposit low", subject_to_sale: "Subject to sale",
  settlement_flex_trade: "Trade time for certainty", price_gap_compromise: "Price compromise"
};
const rate = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

/** How Elena's settlement suggestions are used and how coached deals end. Counts only: no people and no properties. */
export default function StaffNegotiationCoaching() {
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/staff/negotiation-coaching").then(async r => { if (r.ok) setS(await r.json()); else setError(loadError(r.status)); }).catch(() => setError(loadError(0)));
  }, []);
  const row = (name: string, g: Group) => (
    <tr><th scope="row">{name}</th><td className="num">{g.deals}</td><td className="num">{rate(g.settled, g.deals)}</td><td className="num">{rate(g.fellThrough, g.deals)}</td><td className="num">{g.avgDaysToSettle ?? "–"}</td></tr>
  );
  return (
    <main className="admin-page">
      <h1>Negotiation coaching</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">Which of Elena&apos;s suggestions people use, and how deals that used a suggestion end compared with deals that did not. Small numbers can mislead, and this does not prove cause.</p>
      {error && <p role="alert">{error}</p>}
      {!error && !s && <p className="muted" role="status">Loading…</p>}
      {s && (s.byType.length === 0 ? <p className="empty">No suggestions have been shown yet.</p> : (
        <>
          <h2>Coached and other deals</h2>
          <div className="table-wrap"><table className="settle-table">
            <thead><tr><th scope="col">Deals that ended</th><th scope="col" className="num">Deals</th><th scope="col" className="num">Settled</th><th scope="col" className="num">Fell through</th><th scope="col" className="num">Avg days to settle</th></tr></thead>
            <tbody>{row("Used a suggestion", s.coached)}{row("Did not use one", s.uncoached)}</tbody>
          </table></div>
          <h2>By suggestion</h2>
          <div className="table-wrap"><table className="settle-table">
            <thead><tr><th scope="col">Suggestion</th><th scope="col" className="num">Shown</th><th scope="col" className="num">Used</th><th scope="col" className="num">Ignored</th><th scope="col" className="num">Use rate</th><th scope="col" className="num">Settled</th><th scope="col" className="num">Fell through</th></tr></thead>
            <tbody>{s.byType.map(t => (
              <tr key={t.type}><th scope="row">{LABEL[t.type] ?? t.type}</th><td className="num">{t.shown}</td><td className="num">{t.used}</td><td className="num">{t.dismissed}</td><td className="num">{rate(t.used, t.used + t.dismissed)}</td><td className="num">{t.settled}</td><td className="num">{t.fellThrough}</td></tr>
            ))}</tbody>
          </table></div>
        </>
      ))}
    </main>
  );
}
