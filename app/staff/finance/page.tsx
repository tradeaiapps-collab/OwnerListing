"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/billing.css";
import type { FinanceReport, Insight } from "../../../src/domain/finance-report";
import { BarList, KpiTile, LineChart } from "../charts";
import { loadError, postStaff } from "../staff-api";
import { KIND_LABEL, METHOD_LABEL, dateAu, invoiceState, money } from "../../billing/view";

interface Row { id: string; invoiceNumber?: string; kind?: string; totalCents: number; status: "pending" | "paid" | "failed" | "void" | "refunded"; dueAt?: string; createdAt?: string; paymentMethod?: string; ownerRef: string; disputeOpen: boolean }
interface Dispute { id: string; invoiceNumber: string; totalCents: number; reason: string; createdAt: string; ownerRef: string }

const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "12 months"]] as const;
const FILTERS = [["all", "All"], ["pending", "Unpaid"], ["overdue", "Overdue"], ["paid", "Paid"], ["failed", "Failed or cancelled"]] as const;
const SEVERITY: Record<Insight["severity"], string> = { attention: "bad", opportunity: "good", info: "" };
const SEVERITY_LABEL: Record<Insight["severity"], string> = { attention: "Needs attention", opportunity: "Opportunity", info: "For your information" };

/** Finance: revenue, invoices, bank-transfer reconciliation and customers' payment issues, with Elena's reading of the payment patterns. */
export default function StaffFinance() {
  const [days, setDays] = useState<number>(30);
  const [filter, setFilter] = useState<string>("pending");
  const [report, setReport] = useState<FinanceReport | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bank, setBank] = useState<{ id: string; amount: string; ref: string } | null>(null);
  const [answer, setAnswer] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadReport = useCallback(async (d: number) => {
    const r = await fetch(`/api/staff/finance?days=${d}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const j = await r.json();
    setError(""); setReport(j.report); setInsights(j.insights); setCanManage(j.canManage === true);
    if (j.canManage) {
      const dr = await fetch("/api/staff/finance/disputes?status=open").catch(() => null);
      if (dr?.ok) setDisputes((await dr.json()).disputes);
    }
  }, []);
  const loadRows = useCallback(async (f: string) => {
    const r = await fetch(`/api/staff/finance/invoices?filter=${f}`).catch(() => null);
    if (r?.ok) setRows((await r.json()).invoices);
  }, []);
  useEffect(() => { void loadReport(days); }, [days, loadReport]);
  useEffect(() => { void loadRows(filter); }, [filter, loadRows]);

  async function confirmBank(e: React.FormEvent) {
    e.preventDefault();
    if (!bank) return;
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(bank.amount)) { setError("Enter the amount received in dollars, for example 110 or 110.00."); return; }
    setBusy(true); setError(""); setNotice("");
    const r = await postStaff(`/api/staff/finance/invoices/${bank.id}/bank-transfer`, { amountCents: Math.round(Number(bank.amount) * 100), reference: bank.ref });
    setBusy(false);
    if (r.ok) { setNotice(String(r.data["note"] ?? "Marked paid.")); setBank(null); await Promise.all([loadReport(days), loadRows(filter)]); }
    else setError(String(r.data["error"] ?? "Could not confirm the transfer."));
  }
  async function resolve(outcome: "resolved" | "rejected") {
    if (!answer) return;
    setBusy(true); setError(""); setNotice("");
    const r = await postStaff(`/api/staff/finance/disputes/${answer.id}`, { outcome, resolution: answer.text });
    setBusy(false);
    if (r.ok) { setNotice("Answer saved."); setAnswer(null); await Promise.all([loadReport(days), loadRows(filter)]); }
    else setError(String(r.data["error"] ?? "Could not save the answer."));
  }

  return (
    <main className="admin-page">
      <h1>Finance</h1>
      <p className="muted">The platform's own fees only (excluding GST unless stated). Deposits and buyer money never pass through the platform, so they don't appear here.</p>
      <div className="filters" role="group" aria-label="Period">
        {RANGES.map(([d, label]) => <button key={d} type="button" className={d === days ? "" : "secondary"} aria-pressed={d === days} onClick={() => setDays(d)}>{label}</button>)}
        <a className="button secondary" href={`/api/staff/finance?days=${days}&format=csv`}>Download monthly CSV</a>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice ok" role="status">{notice}</p>}
      {!report && !error && <p className="muted" role="status">Loading...</p>}
      {report && (
        <>
          <div className="kpis">
            <KpiTile kpi={{ key: "rev", label: "Revenue excl. GST", value: report.revenue.current, previous: report.revenue.previous, unit: "cents", hint: `Paid invoices in the last ${days} days` }} />
            <KpiTile kpi={{ key: "gst", label: "GST collected", value: report.gst.current, previous: report.gst.previous, unit: "cents" }} />
            <KpiTile kpi={{ key: "tx", label: "Paid invoices", value: report.transactions.current, previous: report.transactions.previous, unit: "count" }} />
            <KpiTile kpi={{ key: "avg", label: "Average invoice", value: report.averageInvoice.current, previous: report.averageInvoice.previous, unit: "cents", hint: "Including GST" }} />
            <KpiTile kpi={{ key: "mrr", label: "Monthly recurring revenue", value: report.mrrCents, unit: "cents", hint: `${report.activeSubscribers} live subscriber${report.activeSubscribers === 1 ? "" : "s"}, excl. GST` }} />
            <KpiTile kpi={{ key: "fail", label: "Payment failure rate", value: report.failureRatePercent.current, previous: report.failureRatePercent.previous, unit: "percent", hint: "Failed card attempts as a share of all attempts" }} />
            <KpiTile kpi={{ key: "out", label: "Unpaid invoices", value: report.outstanding.totalCents, unit: "cents", hint: `${report.outstanding.count} invoice${report.outstanding.count === 1 ? "" : "s"} including GST` }} />
            <KpiTile kpi={{ key: "od", label: "Overdue", value: report.overdue.totalCents, unit: "cents", hint: `${report.overdue.count} invoice${report.overdue.count === 1 ? "" : "s"}` }} />
          </div>

          <section className="panel" aria-labelledby="elena-ins">
            <div className="elena-bill-head">
              <img src="/assistant/elena-icon.png" alt="" width={48} height={48} />
              <div><h2 id="elena-ins" style={{ margin: 0 }}>Elena's read of the payments</h2><p className="muted">Worked out from the figures on this page. She suggests; you decide, and she never contacts customers or changes prices.</p></div>
            </div>
            <ul className="card-list" style={{ marginTop: "var(--space-4)", marginBottom: 0 }}>
              {insights.map(i => (
                <li key={i.id}>
                  <span className={`status-pill ${SEVERITY[i.severity]}`}>{SEVERITY_LABEL[i.severity]}</span>
                  <strong> {i.title}</strong>
                  <p>{i.detail}</p>
                  <p className="muted">Suggested: {i.action}</p>
                </li>
              ))}
            </ul>
          </section>

          <div className="charts" style={{ marginTop: "var(--space-6)" }}>
            <LineChart title="Revenue by month, excl. GST" labels={report.trend.map(t => new Date(`${t.month}-01T00:00:00Z`).toLocaleDateString("en-AU", { month: "short", year: "2-digit", timeZone: "UTC" }))} series={[{ key: "rev", label: "Revenue", values: report.trend.map(t => t.revenueCents) }]} format={c => money(c)} />
            <BarList title={`Revenue by type, last ${days} days (incl. GST)`} data={report.byKind.map(k => ({ key: k.key, label: KIND_LABEL[k.key] ?? k.key, value: k.totalCents }))} format={c => money(c)} />
            <BarList title="Revenue by payment method (incl. GST)" data={report.byMethod.map(k => ({ key: k.key, label: METHOD_LABEL[k.key] ?? k.key, value: k.totalCents }))} format={c => money(c)} />
            <BarList title="Subscription revenue per month by plan" data={report.bySubscriptionPlan.map(p => ({ key: p.planId, label: `${p.name} (${p.subscribers})`, value: p.mrrCents }))} format={c => money(c)} />
          </div>
        </>
      )}

      {canManage && (
        <section className="panel" aria-labelledby="disp-h" style={{ marginTop: "var(--space-6)" }}>
          <h2 id="disp-h">Payment issues</h2>
          {disputes.length === 0 ? <p className="empty">No open payment issues.</p> : (
            <ul className="card-list">
              {disputes.map(d => (
                <li key={d.id}>
                  <strong>{d.invoiceNumber}</strong> <span className="muted">{money(d.totalCents)}, customer {d.ownerRef}, raised {dateAu(d.createdAt)}</span>
                  <p style={{ whiteSpace: "pre-wrap" }}>{d.reason}</p>
                  {answer?.id === d.id ? (
                    <div className="stack">
                      <label>Written answer for the customer
                        <textarea value={answer.text} onChange={e => setAnswer({ id: d.id, text: e.target.value })} minLength={10} maxLength={1000} rows={3} />
                      </label>
                      <div className="row-actions">
                        <button type="button" disabled={busy} onClick={() => void resolve("resolved")}>Resolve</button>
                        <button type="button" className="secondary" disabled={busy} onClick={() => void resolve("rejected")}>Reject</button>
                        <button type="button" className="secondary" onClick={() => setAnswer(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : <div className="row-actions"><button type="button" className="secondary" onClick={() => setAnswer({ id: d.id, text: "" })}>Answer</button></div>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="invs-h" style={{ marginTop: "var(--space-6)" }}>
        <h2 id="invs-h">Invoices</h2>
        <div className="filters" role="group" aria-label="Invoice filter">
          {FILTERS.map(([k, label]) => <button key={k} type="button" className={k === filter ? "" : "secondary"} aria-pressed={k === filter} onClick={() => setFilter(k)}>{label}</button>)}
        </div>
        {bank && (
          <form className="stack panel" onSubmit={confirmBank}>
            <strong>Confirm bank transfer</strong>
            <label>Amount received in dollars (must equal the invoice total)
              <input inputMode="decimal" value={bank.amount} onChange={e => setBank({ ...bank, amount: e.target.value })} required />
            </label>
            <label>Bank reference or statement line
              <input value={bank.ref} onChange={e => setBank({ ...bank, ref: e.target.value })} minLength={3} maxLength={100} required />
            </label>
            <div className="row-actions"><button type="submit" disabled={busy}>{busy ? "Saving..." : "Mark as paid"}</button><button type="button" className="secondary" onClick={() => setBank(null)}>Cancel</button></div>
          </form>
        )}
        {rows.length === 0 ? <p className="empty">No invoices match.</p> : (
          <div className="table-wrap">
            <table className="inv-table wide">
              <thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">For</th><th scope="col">Date</th><th scope="col">Due</th><th scope="col" className="num">Total</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
              <tbody>
                {rows.map(r => {
                  const s = invoiceState(r);
                  return (
                    <tr key={r.id}>
                      <td>{r.invoiceNumber}</td><td>{r.ownerRef}</td><td>{KIND_LABEL[r.kind ?? "other"]}</td>
                      <td>{r.createdAt ? dateAu(r.createdAt) : ""}</td><td>{r.dueAt ? dateAu(r.dueAt) : ""}</td>
                      <td className="num">{money(r.totalCents)}</td>
                      <td><span className={`status-pill ${s.tone}`}>{s.label}</span>{r.disputeOpen && <> <span className="status-pill warn">Issue open</span></>}</td>
                      <td>{canManage && r.status === "pending" && <button type="button" className="secondary" onClick={() => setBank({ id: r.id, amount: (r.totalCents / 100).toFixed(2), ref: "" })}>Mark paid<span className="sr-only"> by bank transfer, {r.invoiceNumber}</span></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
