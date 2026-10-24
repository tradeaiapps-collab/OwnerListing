"use client";
import { useEffect, useState } from "react";
import type { OwnerReport } from "../../src/domain/reports";
import "../styles/reports.css";

/** The signed-in owner's own listings. Page views are not tracked, so enquiries and offers are shown. */
export default function OwnerReportPage() {
  const [report, setReport] = useState<OwnerReport | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetch("/api/listings/mine/report").then(async r => {
      if (!r.ok) { setMessage(r.status === 401 ? "Sign in to see your report." : "Could not load your report."); return; }
      setReport((await r.json()).report);
    }).catch(() => setMessage("Could not load your report."));
  }, []);

  return (
    <main>
      <h1>My listing report</h1>
      {message && <p role="alert">{message}</p>}
      {report && (
        <>
          <p className="report-note">Page views are not tracked yet, so this report counts enquiries and offers for each of your listings.</p>
          <div className="report-actions"><a href="/api/listings/mine/report?format=csv" download>Download CSV</a></div>
          {report.listings.length === 0 ? <p className="empty">You have no listings yet.</p> : (
            <table className="report-table">
              <thead><tr><th>Listing</th><th>Status</th><th className="num">Enquiries</th><th className="num">Offers</th></tr></thead>
              <tbody>
                {report.listings.map(l => <tr key={l.id}><td><a href={`/listings/${l.id}`}>{l.title}</a></td><td>{l.status.replace(/_/g, " ")}</td><td className="num">{l.enquiries}</td><td className="num">{l.offers}</td></tr>)}
                <tr><th>Total</th><td></td><td className="num">{report.totals.enquiries}</td><td className="num">{report.totals.offers}</td></tr>
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
