"use client";
import { useEffect, useState } from "react";
import { formatKpi } from "../../../src/domain/admin-dashboard";
import { DIMENSIONS, type BuiltReport, type Dimension } from "../../../src/domain/admin-report-builder";
import { loadError } from "../staff-api";

/** Report builder: pick a period and a grouping (property type, sale or rent, state, suburb, agent), view the table, download it as CSV. */
export default function ReportBuilder() {
  const [f, setF] = useState({ dimension: "category" as Dimension, from: "", to: "" });
  const [report, setReport] = useState<BuiltReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const params = (q: typeof f) => {
    const p = new URLSearchParams({ dimension: q.dimension });
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
    return p;
  };

  async function load(q: typeof f) {
    setBusy(true); setError("");
    const r = await fetch(`/api/staff/report-builder?${params(q)}`).catch(() => null);
    setBusy(false);
    if (!r) { setError(loadError(0)); return; }
    if (!r.ok) { setError(r.status === 400 ? (await r.json().catch(() => ({}))).error ?? "Check the filters." : loadError(r.status)); return; }
    const b: BuiltReport = (await r.json()).report;
    setReport(b);
    setF({ dimension: b.query.dimension, from: b.query.range.from, to: b.query.range.to });
  }

  useEffect(() => { void load(f); }, []);

  const money = (c?: number) => formatKpi(c ?? 0, "cents");
  const num = (r: Omit<BuiltReport["rows"][number], "key" | "label">) => [r.listingsCreated, r.liveNow, r.offers, r.accepted, `${r.acceptance}%`];

  return (
    <main className="admin-page">
      <h1>Report builder</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(f); }}>
        <label>Group by
          <select value={f.dimension} onChange={e => setF({ ...f, dimension: e.target.value as Dimension })}>
            {DIMENSIONS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </label>
        <label>From <input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
        <label>To <input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Run report"}</button>
        {report && <a href={`/api/staff/report-builder?${params({ dimension: report.query.dimension, from: report.query.range.from, to: report.query.range.to })}&format=csv`} download>Download CSV</a>}
      </form>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p className="muted">
            Listings created {report.query.range.from} to {report.query.range.to}, grouped by {report.dimensionLabel.toLowerCase()}. &ldquo;Live now&rdquo; is
            today&apos;s status. Offers are those submitted in the period.{report.revenueIncluded ? " Platform fees are listing invoices paid in the period." : ""}
          </p>
          {report.rows.length === 0 ? <p className="empty">Nothing in this period.</p> : (
            <div className="table-wrap"><table>
              <thead><tr>
                <th scope="col">{report.dimensionLabel}</th><th scope="col">Listings created</th><th scope="col">Live now</th>
                <th scope="col">Offers</th><th scope="col">Accepted</th><th scope="col">Acceptance</th>
                {report.revenueIncluded && <th scope="col">Platform fees paid</th>}
              </tr></thead>
              <tbody>
                {report.rows.map(r => (
                  <tr key={r.key}><th scope="row">{r.label}</th>{num(r).map((v, i) => <td key={i}>{v}</td>)}{report.revenueIncluded && <td>{money(r.revenueCents)}</td>}</tr>
                ))}
              </tbody>
              <tfoot><tr><th scope="row">Total</th>{num(report.totals).map((v, i) => <td key={i}><strong>{v}</strong></td>)}{report.revenueIncluded && <td><strong>{money(report.totals.revenueCents)}</strong></td>}</tr></tfoot>
            </table></div>
          )}
        </>
      )}
    </main>
  );
}
