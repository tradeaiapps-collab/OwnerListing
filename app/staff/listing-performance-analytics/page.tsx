"use client";
import { useEffect, useState } from "react";
import type { StaffReport } from "../../../src/server/listing-performance-db";
import { DataTable, KpiTile, LineChart } from "../charts";
import { loadError } from "../staff-api";
import "../../styles/listing-performance.css";

/** Platform listing performance: 30-day totals and rates, median days to first offer and acceptance, a 90-day chart and listings that need attention. */
export default function ListingPerformanceAnalytics() {
  const [d, setD] = useState<StaffReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/staff/listing-performance-analytics").then(async r => {
      if (!r.ok) { setError(loadError(r.status)); return; }
      setD(await r.json());
    }).catch(() => setError("Could not load."));
  }, []);
  return (
    <main className="admin-page">
      <h1>Listing performance</h1>
      <p><a href="/staff/analytics">Back to analytics</a></p>
      {error && <p role="alert">{error}</p>}
      {!d && !error && <p className="muted" role="status">Loading…</p>}
      {d && (
        <>
          <p className="muted">{d.listings} live listing{d.listings === 1 ? "" : "s"} for sale · last 30 days · updated {new Date(d.asOf).toLocaleString("en-AU")}</p>
          <div className="kpis">
            <KpiTile kpi={{ key: "k1", label: "Views", value: d.totals30.views, unit: "count" }} />
            <KpiTile kpi={{ key: "k2", label: "Inquiries", value: d.totals30.inquiries, unit: "count" }} />
            <KpiTile kpi={{ key: "k3", label: "Offers", value: d.totals30.offers, unit: "count" }} />
            <Tile label="Inquiry rate" value={d.totals30.inquiryRatePct === null ? "n/a" : `${d.totals30.inquiryRatePct}%`} hint={d.totals30.inquiryRatePct === null ? "Needs 20 views" : "Inquiries per 100 views"} />
            <Tile label="Offers per 100 views" value={d.totals30.offersPer100Views === null ? "n/a" : String(d.totals30.offersPer100Views)} hint={d.totals30.offersPer100Views === null ? "Needs 20 views" : undefined} />
            <Tile label="Median days to first offer" value={d.medianDaysToFirstOffer === undefined ? "n/a" : String(d.medianDaysToFirstOffer)} hint={d.medianDaysToFirstOffer === undefined ? "No accepted sales recorded yet" : `From ${d.outcomes} accepted sales`} />
            <Tile label="Median days to acceptance" value={d.medianDaysToAcceptance === undefined ? "n/a" : String(d.medianDaysToAcceptance)} hint={d.medianDaysToAcceptance === undefined ? "No accepted sales recorded yet" : `From ${d.outcomes} accepted sales`} />
          </div>
          <section className="lp-section">
            <h2>Last 90 days</h2>
            <LineChart title="Views, inquiries and offers across live listings" labels={d.daily.map(x => x.date.slice(5))} series={[
              { key: "views", label: "Views", values: d.daily.map(x => x.views) }, { key: "inq", label: "Inquiries", values: d.daily.map(x => x.inquiries) }, { key: "off", label: "Offers", values: d.daily.map(x => x.offers) }]} />
          </section>
          <section className="lp-section">
            <h2>Needs attention</h2>
            {d.needsAttention.length === 0 ? <p className="muted">No listings flagged.</p> : (
              <DataTable head={["Listing", "Suburb", "Days live", "Views (30d)", "Inquiries (30d)", "Why"]}
                rows={d.needsAttention.map(l => [l.title, l.suburb ?? "n/a", l.ageDays, l.views30, l.inquiries30, l.flag ?? ""])} />
            )}
          </section>
          <p className="muted">{d.note}</p>
        </>
      )}
    </main>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      {hint && <span className="kpi-change">{hint}</span>}
    </div>
  );
}
