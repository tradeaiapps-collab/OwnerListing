"use client";
import { useCallback, useEffect, useState } from "react";
import type { AgentTotals, CommissionDeal, CommissionPayout, ElenaCommissionSummary, Forecast, Statement } from "../../../src/domain/commission";
import { PRESENTER_SPEAK_EVENT } from "../../presenter/presenter-core";
import { dateLabel, money, monthLabel, STATUS_LABEL, termsLabel } from "../../commissions-ui";
import "../../styles/reports.css";
import "../../styles/commissions.css";

interface Data { deals: CommissionDeal[]; payouts: CommissionPayout[]; totals: AgentTotals; statement: Statement; forecast: Forecast; elena: ElenaCommissionSummary }

const thisMonth = () => new Date().toISOString().slice(0, 7);

/** Agent screen: my commission deals, payment dates, monthly statement, and Elena's summary and earnings outlook. Read only. */
export default function AgentCommissions() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [month, setMonth] = useState(thisMonth());

  const load = useCallback(async (m: string) => {
    setError("");
    try {
      const r = await fetch(`/api/agent/commissions?month=${encodeURIComponent(m)}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) setData(d);
      else setError(r.status === 401 ? "Sign in to see your commissions." : r.status === 403 ? "Commissions are for agent accounts." : d.error ?? "Could not load your commissions.");
    } catch {
      setError("Could not load your commissions.");
    }
  }, []);

  useEffect(() => { void load(month); }, [load, month]);

  const today = new Date().toISOString().slice(0, 10);
  const maxBar = Math.max(1, ...(data?.forecast.months.map(m => m.totalCents) ?? [1]));
  const title = (id: string) => data?.deals.find(d => d.id === id)?.title ?? "Deal";
  const open = data?.payouts.filter(p => p.status !== "cancelled") ?? [];

  function speak() {
    if (data) window.dispatchEvent(new CustomEvent(PRESENTER_SPEAK_EVENT, { detail: { text: data.elena.text } }));
  }

  return (
    <main>
      <h1>My commissions</h1>
      <p className="muted">A record of commission owed to you. The platform holds no money; you are paid outside the platform and staff confirm it here.</p>
      {error && <p role="alert">{error}</p>}
      {!error && !data && <p className="muted" role="status">Loading…</p>}
      {data && (
        <>
          <section className="cm-elena" aria-labelledby="cm-elena-h">
            <h2 id="cm-elena-h">Elena&apos;s summary</h2>
            <p>{data.elena.text}</p>
            <div className="cm-actions"><button type="button" className="secondary" onClick={speak}>Read it to me</button></div>
            <p className="cm-note">{data.elena.disclaimer}</p>
          </section>

          <dl className="cm-tiles" aria-label="Commission totals">
            <div className="cm-tile"><dt>Earned</dt><dd>{money(data.totals.earnedCents)}</dd></div>
            <div className="cm-tile"><dt>Paid</dt><dd>{money(data.totals.paidCents)}</dd></div>
            <div className="cm-tile"><dt>Due</dt><dd>{money(data.totals.dueCents)}</dd></div>
            <div className={`cm-tile${data.totals.overdueCents > 0 ? " warn" : ""}`}><dt>Overdue</dt><dd>{money(data.totals.overdueCents)}</dd></div>
            <div className="cm-tile"><dt>Open deals</dt><dd>{money(data.totals.expectedCents)}</dd></div>
          </dl>

          <h2>Expected earnings</h2>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Expected earnings by month</caption>
              <thead><tr><th scope="col">Month</th><th scope="col" className="num">Dated payments</th><th scope="col" className="num">Open deals</th><th scope="col" className="num">Total</th><th scope="col">Size</th></tr></thead>
              <tbody>
                {data.forecast.months.map(m => (
                  <tr key={m.month}>
                    <th scope="row">{monthLabel(m.month)}</th>
                    <td className="num">{money(m.scheduledCents)}</td><td className="num">{money(m.pipelineCents)}</td><td className="num">{money(m.totalCents)}</td>
                    <td><span className="cm-bars" aria-hidden="true">
                      <span className="cm-bar" style={{ width: `${(m.scheduledCents / maxBar) * 100}%` }} />
                      <span className="cm-bar pipeline" style={{ width: `${(m.pipelineCents / maxBar) * 100}%` }} />
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="cm-note">{data.forecast.method} Close rate {Math.round(data.forecast.closeRate * 100)}% ({data.forecast.closeRateBasis === "history" ? "from your history" : "default"}). Confidence: {data.forecast.confidence}.</p>

          <h2>My deals</h2>
          {data.deals.length === 0 ? <p className="empty">No commission deals have been recorded for you yet.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Deal</th><th scope="col">Date</th><th scope="col">Terms</th><th scope="col" className="num">Sale price</th><th scope="col" className="num">Commission</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {data.deals.map(d => (
                    <tr key={d.id}>
                      <th scope="row">{d.listingId ? <a href={`/listings/${d.listingId}`}>{d.title}</a> : d.title}</th>
                      <td>{dateLabel(d.dealDate)}</td><td>{termsLabel(d.terms)}</td>
                      <td className="num">{money(d.salePriceCents)}</td>
                      <td className="num">{money(d.overrideCents ?? d.calculatedCents)}{d.overrideCents !== null && <small className="muted"> (adjusted by staff)</small>}</td>
                      <td><span className={`cm-status ${d.status}`}>{STATUS_LABEL[d.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2>Payment schedule</h2>
          {open.length === 0 ? <p className="empty">No payments are scheduled.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Due</th><th scope="col">Deal</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col">Reference</th></tr></thead>
                <tbody>
                  {open.map(p => {
                    const late = p.status === "scheduled" && p.dueDate < today;
                    return (
                      <tr key={p.id}>
                        <th scope="row">{dateLabel(p.dueDate)}</th><td>{title(p.dealId)}</td><td className="num">{money(p.amountCents)}</td>
                        <td><span className={`cm-status ${late ? "overdue" : p.status}`}>{late ? "Overdue" : p.status === "paid" ? "Paid" : "Scheduled"}</span></td>
                        <td>{p.paymentReference ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data.totals.unscheduledCents > 0 && <p className="cm-note">{money(data.totals.unscheduledCents)} of your commission has no payment date yet.</p>}

          <h2>Monthly statement</h2>
          <div className="cm-row">
            <label>Month<input type="month" value={month} max={thisMonth()} onChange={e => e.target.value && setMonth(e.target.value)} /></label>
            <a className="button secondary" href={`/api/agent/commissions?month=${encodeURIComponent(month)}&format=csv`} download>Download CSV</a>
          </div>
          {data.statement.lines.length === 0 ? <p className="empty">Nothing was paid or falls due in {monthLabel(month)}.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Date</th><th scope="col">Deal</th><th scope="col">Status</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody>
                  {data.statement.lines.map((l, i) => (
                    <tr key={`${l.date}-${i}`}><th scope="row">{dateLabel(l.date)}</th><td>{l.dealTitle}</td><td><span className={`cm-status ${l.kind === "paid" ? "paid" : "scheduled"}`}>{l.kind === "paid" ? "Paid" : "Due"}</span></td><td className="num">{money(l.amountCents)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><th scope="row" colSpan={3}>Paid {money(data.statement.paidCents)} · Due {money(data.statement.dueCents)}</th><td /></tr></tfoot>
              </table>
            </div>
          )}
          <p><a href="/agent/appointments">Appointments</a> · <a href="/agent/listings">Enquiry inbox</a></p>
        </>
      )}
    </main>
  );
}
