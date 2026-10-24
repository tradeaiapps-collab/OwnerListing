"use client";
import { useEffect, useState } from "react";
import type { StaffReport } from "../../../src/domain/reports";
import { loadError } from "../staff-api";
import "../../styles/reports.css";

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Table({ head, rows }: { head: [string, string]; rows: [string, number | string][] }) {
  return (
    <table className="report-table">
      <thead><tr><th>{head[0]}</th><th className="num">{head[1]}</th></tr></thead>
      <tbody>{rows.map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, " ")}</td><td className="num">{v}</td></tr>)}</tbody>
    </table>
  );
}

export default function StaffReports() {
  const [report, setReport] = useState<StaffReport | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetch("/api/staff/reports").then(async r => {
      if (!r.ok) { setMessage(loadError(r.status)); return; }
      setReport((await r.json()).report);
    }).catch(() => setMessage(loadError(0)));
  }, []);

  return (
    <main>
      <h1>Reports</h1>
      <p><a href="/staff">Back to staff</a></p>
      {message && <p role="alert">{message}</p>}
      {report && (
        <>
          <div className="report-actions"><a href="/api/staff/reports?format=csv" download>Download CSV</a></div>
          <div className="report-grid">
            {report.listings && <section className="report-card"><h2>Listings by status</h2><Table head={["Status", "Listings"]} rows={report.listings.map(l => [l.status, l.count])} /></section>}
            {report.revenue && (
              <section className="report-card">
                <h2>Revenue from paid invoices</h2>
                <p className="muted">Platform fees only. The platform holds no money; deposits go to the solicitor&apos;s trust account.</p>
                <Table head={["Measure", "Amount"]} rows={[
                  ["Paid invoices", report.revenue.paidInvoices], ["Total incl. GST", money(report.revenue.totalCents)], ["GST", money(report.revenue.gstCents)],
                  ["Total excl. GST", money(report.revenue.exGstCents)], ["Last 30 days incl. GST", money(report.revenue.last30DaysCents)]
                ]} />
              </section>
            )}
            {report.openCases && <section className="report-card"><h2>Open cases ({report.openCases.total})</h2><Table head={["Kind", "Open"]} rows={report.openCases.byKind.map(k => [k.kind, k.count])} /></section>}
            {report.verificationFunnel && (
              <>
                <section className="report-card"><h2>Buyer verification</h2><Table head={["Step", "Buyers"]} rows={report.verificationFunnel.buyers.map(b => [b.step, b.count])} /></section>
                <section className="report-card"><h2>ID submissions</h2><Table head={["Status", "Count"]} rows={report.verificationFunnel.idSubmissions.map(s => [s.status, s.count])} /></section>
                <section className="report-card"><h2>Trust account checks</h2><Table head={["Decision", "Jobs"]} rows={report.verificationFunnel.trustAccountChecks.map(t => [t.decision, t.count])} /></section>
              </>
            )}
          </div>
        </>
      )}
    </main>
  );
}
