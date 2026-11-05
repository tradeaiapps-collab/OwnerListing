"use client";
import { useCallback, useEffect, useState } from "react";
import type { PerformanceReport } from "../../../src/server/listing-performance-db";
import { WINDOWS, HEAT_BLOCKS, HEAT_DAYS, type Window } from "../../../src/domain/listing-performance";
import { LineChart } from "../../staff/charts";
import "../../styles/market.css";
import "../../styles/seller-insights.css";
import "../../styles/listing-performance.css";

interface Mine { id: string; title: string; address: string; transactionType: string }
const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const pct = (n: number | null) => (n === null ? "n/a" : `${n}%`);
const arrow = (n: number | null | undefined) => (n == null ? "" : n > 0 ? "▲ " : n < 0 ? "▼ " : "■ ");
const gapText = (n: number | null, what: string) => (n === null ? "No market figure yet" : n === 0 ? `Same as similar listings` : `${Math.abs(Math.round(n))}% ${n > 0 ? "above" : "below"} similar listings ${what}`.trim());
const cls = (n: number | null) => (n === null ? "" : n > 0 ? "lp-up" : n < 0 ? "lp-down" : "");

export default function ListingPerformancePage() {
  const [listings, setListings] = useState<Mine[]>([]);
  const [id, setId] = useState("");
  const [win, setWin] = useState<Window>(30);
  const [rep, setRep] = useState<PerformanceReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (listingId: string) => {
    if (!listingId) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/owner/listing-performance?listing=${encodeURIComponent(listingId)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(typeof d.error === "string" ? d.error : d.error?.message ?? "Could not load performance."); setRep(null); return; }
      setRep(d as PerformanceReport);
    } catch { setError("Could not load performance."); setRep(null); } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    fetch("/api/listings/mine").then(async r => {
      if (r.status === 401) { setSignedOut(true); return; }
      const d = await r.json().catch(() => ({}));
      const sale = ((d.listings ?? []) as Mine[]).filter(l => l.transactionType === "sale");
      setListings(sale);
      const want = new URLSearchParams(window.location.search).get("listing");
      const first = sale.find(l => l.id === want) ?? sale[0];
      if (first) { setId(first.id); void load(first.id); }
    }).catch(() => setError("Could not load your listings.")).finally(() => setLoaded(true));
  }, [load]);

  const w = rep?.windows.find(x => x.days === win);
  const m = rep?.market.state === "ready" ? rep.market : null;
  const chart = rep ? rep.daily.slice(-Math.max(2, Math.min(win, rep.listing.ageDays))) : [];
  return (
    <main className="mk">
      <h1>Listing performance</h1>
      <p className="muted">See how buyers are responding to your listing, how it compares with similar ones, and what Elena suggests. Guide only; you set the price.</p>
      {signedOut && <p role="alert">Sign in to see your listing performance. <a href="/login">Sign in</a></p>}
      {error && <p role="alert">{error}</p>}
      {loaded && !signedOut && listings.length === 0 && !error && <p className="empty">You have no listings for sale yet.</p>}
      {listings.length > 0 && (
        <div className="panel">
          <label>Listing<select value={id} onChange={e => { setId(e.target.value); void load(e.target.value); }}>{listings.map(l => <option key={l.id} value={l.id}>{l.title || l.address}</option>)}</select></label>
          <div className="lp-windows" role="group" aria-label="Time window">
            {WINDOWS.map(d => <button key={d} type="button" aria-pressed={win === d} onClick={() => setWin(d)}>Last {d} days</button>)}
          </div>
        </div>
      )}
      {busy && !rep && <p className="muted" role="status">Loading…</p>}
      {rep && w && (
        <>
          <p className="muted" role="status">Live {rep.listing.ageDays} day{rep.listing.ageDays === 1 ? "" : "s"}{rep.listing.priceCents ? ` · asking ${aud.format(rep.listing.priceCents / 100)}` : ""} · updated {new Date(rep.asOf).toLocaleString("en-AU")}</p>
          <div className="lp-cards">
            <div className="lp-card"><h3>Views</h3><strong>{w.views}</strong>
              <span className={w.trend.direction === "up" ? "lp-up" : w.trend.direction === "down" ? "lp-down" : ""}>{w.trend.changePct === null ? "No earlier period to compare" : `${arrow(w.trend.changePct)}${Math.abs(w.trend.changePct)}% vs the ${win} days before`}</span>
              {win === 30 && m && <span className={cls(m.viewsGapPct)}>{gapText(m.viewsGapPct, "")}</span>}</div>
            <div className="lp-card"><h3>Inquiries</h3><strong>{w.inquiries}</strong>
              <span>{w.inquiryRatePct === null ? "Rate shows after 20 views" : `${pct(w.inquiryRatePct)} of viewers enquire`}</span>
              {win === 30 && m && <span className={cls(m.inquiryRateGapPct)}>{gapText(m.inquiryRateGapPct, "")}</span>}</div>
            <div className="lp-card"><h3>Offers</h3><strong>{w.offers}</strong>
              <span>{w.offersPer100Views === null ? "Rate shows after 20 views" : `${w.offersPer100Views} per 100 views`}</span>
              {win === 30 && m && <span className={cls(m.offerRateGapPct)}>{gapText(m.offerRateGapPct, "")}</span>}</div>
            <div className="lp-card"><h3>Time to first offer</h3><strong>{rep.daysToFirstOffer === null ? "None yet" : `${rep.daysToFirstOffer} day${rep.daysToFirstOffer === 1 ? "" : "s"}`}</strong>
              <span>{m?.average.medianDaysToFirstOffer !== undefined ? `Similar listings: about ${m.average.medianDaysToFirstOffer} days` : "No market figure yet"}</span></div>
          </div>
          {win !== 30 && <p className="muted">Comparisons with similar listings use the last 30 days.</p>}

          <section className="panel lp-section" aria-labelledby="lp-elena">
            <h2 id="lp-elena">Elena's read</h2>
            <div className="lp-advice">
              <div className="lp-risk" data-level={rep.advice.risk.level}><p><strong>{rep.advice.risk.message}</strong></p>{rep.advice.risk.reasons.map(r => <p key={r} className="muted">{r}</p>)}</div>
              <p>{rep.advice.prediction.message}</p>
              <p>{rep.advice.recommendation.message}</p>
            </div>
          </section>

          <section className="panel lp-section lp-chart" aria-labelledby="lp-timeline">
            <h2 id="lp-timeline">Views, inquiries and offers</h2>
            <LineChart title={`Last ${win} days`} labels={chart.map(d => d.date.slice(5))} series={[
              { key: "views", label: "Views", values: chart.map(d => d.views) }, { key: "inq", label: "Inquiries", values: chart.map(d => d.inquiries) }, { key: "off", label: "Offers", values: chart.map(d => d.offers) }]} />
          </section>

          <section className="panel lp-section" aria-labelledby="lp-market">
            <h2 id="lp-market">Compared with similar listings</h2>
            {rep.market.state === "unavailable" ? <p className="muted" role="status">{rep.market.message}</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th scope="col">Listing</th><th scope="col" className="num">Asking</th><th scope="col" className="num">Views/day</th><th scope="col" className="num">Enquiry rate</th><th scope="col" className="num">Offers/100 views</th></tr></thead>
                <tbody>
                  <tr className="lp-mine"><td>Yours</td><td className="num">{rep.listing.priceCents ? aud.format(rep.listing.priceCents / 100) : "n/a"}</td><td className="num">{rep.windows.find(x => x.days === 30)!.viewsPerDay}</td><td className="num">{pct(rep.windows.find(x => x.days === 30)!.inquiryRatePct)}</td><td className="num">{rep.windows.find(x => x.days === 30)!.offersPer100Views ?? "n/a"}</td></tr>
                  {rep.market.rows.map(r => <tr key={r.label}><td>Listing {r.label}{r.bedrooms !== undefined ? `, ${r.bedrooms} bed` : ""}</td><td className="num">{r.priceCents ? aud.format(r.priceCents / 100) : "n/a"}</td><td className="num">{r.viewsPerDay}</td><td className="num">{pct(r.inquiryRatePct)}</td><td className="num">{r.offersPer100Views ?? "n/a"}</td></tr>)}
                  <tr><th scope="row">Average</th><td className="num">{rep.market.average.medianAskingCents ? aud.format(rep.market.average.medianAskingCents / 100) : "n/a"}</td><td className="num">{rep.market.average.viewsPerDay}</td><td className="num">{pct(rep.market.average.inquiryRatePct)}</td><td className="num">{rep.market.average.offersPer100Views ?? "n/a"}</td></tr>
                </tbody>
              </table></div>
            )}
            <p className="muted">Other sellers' listings are not named. Updated daily.</p>
          </section>

          <section className="panel lp-section" aria-labelledby="lp-heat">
            <h2 id="lp-heat">When buyers look</h2>
            {rep.heatmap.state === "unavailable" ? <p className="muted" role="status">{rep.heatmap.message}</p> : (
              <>
                <p>Busiest: {rep.heatmap.peak.day}, {rep.heatmap.peak.block} (Australian local time, last 90 days; a = am, p = pm).</p>
                <table className="lp-heat"><caption className="sr-only">Views by day and time</caption>
                  <thead><tr><td />{HEAT_BLOCKS.map(b => <th key={b} scope="col">{b}</th>)}</tr></thead>
                  <tbody>{HEAT_DAYS.map((d, i) => { const max = Math.max(1, ...rep.heatmap.state === "ready" ? rep.heatmap.cells.flat() : [1]); return (
                    <tr key={d}><th scope="row">{d}</th>{rep.heatmap.state === "ready" && rep.heatmap.cells[i]!.map((n, j) => <td key={j} style={{ ["--heat" as string]: n / max }} data-hot={n / max > 0.55 ? 1 : 0}>{n}</td>)}</tr>); })}</tbody>
                </table>
              </>
            )}
          </section>
          <p className="muted">{rep.note}</p>
        </>
      )}
      <p className="si-links"><a href="/owner/pricing-advice">Pricing advice</a> <a href="/owner/market-insights">Market insights</a></p>
    </main>
  );
}
