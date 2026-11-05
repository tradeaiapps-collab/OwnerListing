"use client";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Analytics, Bucket } from "../../../src/domain/admin-analytics";
import { formatKpi } from "../../../src/domain/admin-dashboard";
import { BarList, LineChart } from "../charts";
import { loadError } from "../staff-api";
import { BenchmarkPanel } from "./benchmark-panel";
import { ForecastPanel } from "./forecast-panel";
import { TrendsPanel } from "./trends-panel";

const PRESETS: { label: string; days: number; bucket: Bucket }[] = [
  { label: "Last 30 days", days: 30, bucket: "day" },
  { label: "Last 90 days", days: 90, bucket: "week" },
  { label: "Last 12 months", days: 365, bucket: "month" }
];
const dollars = (cents: number) => formatKpi(cents, "cents");

const TABS = [
  { key: "overview", label: "Platform overview" },
  { key: "forecast", label: "Market forecast" },
  { key: "benchmarks", label: "Agent benchmarks" },
  { key: "trends", label: "Team trends" }
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Analytics suite: platform overview, market forecast, agent benchmarks and team trends, one tab each. The tab is kept in the URL hash. */
export default function StaffAnalytics() {
  const [tab, setTab] = useState<Tab>("overview");
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      setTab(TABS.some(t => t.key === h) ? (h as Tab) : "overview");
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  const choose = (t: Tab) => {
    setTab(t);
    window.history.replaceState(null, "", t === "overview" ? window.location.pathname : `#${t}`);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex(t => t.key === tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    choose(TABS[next]!.key);
    document.getElementById(`an-tab-${TABS[next]!.key}`)?.focus();
  };

  return (
    <main className="admin-page">
      <h1>Analytics</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <div className="an-tabs" role="tablist" aria-label="Analytics views" onKeyDown={onKey}>
        {TABS.map(t => (
          <button key={t.key} type="button" role="tab" id={`an-tab-${t.key}`} aria-controls={`an-panel-${t.key}`} aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1} onClick={() => choose(t.key)}>{t.label}</button>
        ))}
      </div>
      {/* Panels mount on first view and stay mounted, so switching back keeps their filters. */}
      {TABS.map(t => (
        <div key={t.key} role="tabpanel" id={`an-panel-${t.key}`} aria-labelledby={`an-tab-${t.key}`} hidden={tab !== t.key} tabIndex={0} className="an-panel">
          <Lazy show={tab === t.key}>
            {t.key === "overview" ? <Overview /> : t.key === "forecast" ? <ForecastPanel endpoint="/api/staff/analytics/forecast" />
              : t.key === "benchmarks" ? <BenchmarkPanel /> : <TrendsPanel />}
          </Lazy>
        </div>
      ))}
    </main>
  );
}

function Lazy({ show, children }: { show: boolean; children: ReactNode }) {
  const [seen, setSeen] = useState(show);
  useEffect(() => { if (show) setSeen(true); }, [show]);
  return seen ? <>{children}</> : null;
}

/** Platform analytics over time: listings, offers, acceptance, platform fees and new accounts, with a period and bucket filter. */
function Overview() {
  const [f, setF] = useState({ from: "", to: "", bucket: "week" as Bucket });
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(q: typeof f) {
    setBusy(true); setError("");
    const p = new URLSearchParams({ bucket: q.bucket });
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
    const r = await fetch(`/api/staff/analytics?${p}`).catch(() => null);
    setBusy(false);
    if (!r) { setError(loadError(0)); return; }
    if (!r.ok) { setError(r.status === 400 ? (await r.json().catch(() => ({}))).error ?? "Check the dates." : loadError(r.status)); return; }
    const a: Analytics = (await r.json()).analytics;
    setData(a);
    setF({ from: a.range.from, to: a.range.to, bucket: a.range.bucket });
  }

  useEffect(() => { void load(f); }, []);

  const preset = (days: number, bucket: Bucket) => {
    const to = data?.range.to ?? "";
    const from = to ? new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10) : "";
    void load({ from, to, bucket });
  };

  return (
    <section aria-label="Platform overview">
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(f); }}>
        <label>From <input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></label>
        <label>To <input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></label>
        <label>Group by
          <select value={f.bucket} onChange={e => setF({ ...f, bucket: e.target.value as Bucket })}>
            <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
          </select>
        </label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Show"}</button>
        {PRESETS.map(p => <button key={p.label} type="button" className="secondary" disabled={busy} onClick={() => preset(p.days, p.bucket)}>{p.label}</button>)}
      </form>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="muted">
            {data.range.from} to {data.range.to}, by {data.range.bucket}, in Queensland time ({data.timeZone}). Offers are counted in the period they were
            submitted; acceptance is accepted offers as a share of offers submitted.
          </p>
          <div className="charts">
            <LineChart title={`Listings (${data.listings[0]!.total} created, ${data.listings[1]!.total} published)`} labels={data.labels} series={data.listings} />
            <LineChart title={`Offers (${data.offers[0]!.total} submitted, ${data.offers[1]!.total} accepted)`} labels={data.labels} series={data.offers} />
            <LineChart title={`Offer acceptance (${data.acceptance[0]!.total}% over the period)`} labels={data.labels} series={data.acceptance} format={n => `${Math.round(n)}%`} />
            {data.revenue && (
              <LineChart title={`Platform fees paid (${dollars(data.revenue[0]!.total)} incl. GST)`} labels={data.labels}
                series={data.revenue.map(s => ({ ...s, label: "Platform fees paid" }))} format={dollars} />
            )}
            <LineChart title="New accounts" labels={data.labels} series={data.users} />
            <BarList title="New accounts by type over the period" data={data.users.map(u => ({ key: u.key, label: u.label, value: u.total }))} />
          </div>
        </>
      )}
    </section>
  );
}
