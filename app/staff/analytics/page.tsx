"use client";
import { useEffect, useState } from "react";
import type { Analytics, Bucket } from "../../../src/domain/admin-analytics";
import { formatKpi } from "../../../src/domain/admin-dashboard";
import type { TeamComparison, Trend } from "../../../src/domain/team-compare";
import { BarList, LineChart } from "../charts";
import { loadError } from "../staff-api";

const PRESETS: { label: string; days: number; bucket: Bucket }[] = [
  { label: "Last 30 days", days: 30, bucket: "day" },
  { label: "Last 90 days", days: 90, bucket: "week" },
  { label: "Last 12 months", days: 365, bucket: "month" }
];
const dollars = (cents: number) => formatKpi(cents, "cents");
/** Short axis labels ("$2.7M") so large team values fit the chart's left margin. */
const compact = (cents: number) => { const d = cents / 100; return d >= 1_000_000 ? `$${(d / 1_000_000).toFixed(1)}M` : d >= 1_000 ? `$${Math.round(d / 1_000)}k` : `$${Math.round(d)}`; };
const delta =(t: Trend) => (t.changePct === undefined ? "new" : `${t.changePct > 0 ? "+" : ""}${t.changePct}%`);

/** Platform analytics over time: listings, offers, acceptance, platform fees and new accounts, with a period and bucket filter. */
export default function StaffAnalytics() {
  const [f, setF] = useState({ from: "", to: "", bucket: "week" as Bucket });
  const [data, setData] = useState<Analytics | null>(null);
  const [teams, setTeams] = useState<TeamComparison | null>(null);
  const [teamsError, setTeamsError] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(q: typeof f) {
    setBusy(true); setError("");
    const p = new URLSearchParams({ bucket: q.bucket });
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
    const [r, tr] = await Promise.all([fetch(`/api/staff/analytics?${p}`).catch(() => null), fetch(`/api/staff/analytics/teams?${p}`).catch(() => null)]);
    setBusy(false);
    // Team figures are a second panel: if they fail the platform charts still show.
    if (tr?.ok) { setTeams((await tr.json()).teams); setTeamsError(false); } else { setTeams(null); setTeamsError(true); }
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
    <main className="admin-page">
      <h1>Platform analytics</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
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

          <h2>Teams</h2>
          {teamsError && <p role="alert">Team figures could not be loaded. The platform charts above are unaffected.</p>}
          {teams && teams.rows.length === 0 && <p className="muted">No agency teams have been set up yet.</p>}
          {teams && teams.rows.length > 0 && (
            <>
              <p className="muted">
                Teams group agents under a manager. Counts cover listings the team&apos;s agents are appointed to now; &quot;Sold&quot; is offers accepted, dated by submission.
                Change is against the equal period before. {teams.note}
              </p>
              <div className="table-wrap"><table>
                <caption className="sr-only">Teams compared over the chosen period</caption>
                <thead><tr>
                  <th scope="col" className="num">Rank</th><th scope="col">Team</th><th scope="col" className="num">People</th><th scope="col" className="num">Listings</th>
                  <th scope="col" className="num">Enquiries</th><th scope="col" className="num">Offers</th><th scope="col" className="num">Sold</th><th scope="col" className="num">Change</th>
                  {teams.showMoney && <><th scope="col" className="num">Sales value</th><th scope="col" className="num">Commission</th></>}
                  <th scope="col">Notes</th>
                </tr></thead>
                <tbody>
                  {teams.rows.map(t => (
                    <tr key={t.id}>
                      <td className="num">{t.rank ?? "–"}</td><td>{t.name}</td><td className="num">{t.members}</td><td className="num">{t.activeListings}</td>
                      <td className="num">{t.enquiries.current}</td><td className="num">{t.offers.current}</td><td className="num">{t.sold.current}</td><td className="num">{delta(t.sold)}</td>
                      {teams.showMoney && <><td className="num">{dollars(t.soldCents?.current ?? 0)}</td><td className="num">{dollars(t.commissionCents ?? 0)}</td></>}
                      <td>{t.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              {teams.alerts.length > 0 && (
                <ul className="card-list" aria-label="Team alerts">
                  {teams.alerts.map(a => <li key={a.id}><span className={`badge ${a.severity === "high" ? "badge-rejected" : "badge-countered"}`}>{a.severity === "high" ? "High" : "Watch"}</span> {a.message}</li>)}
                </ul>
              )}
              <div className="charts">
                {teams.trends && <LineChart title="Offers accepted per team (top teams)" labels={teams.trends.labels} series={teams.trends.sold} />}
                {teams.trends?.soldCents && <LineChart title="Sales value per team (top teams)" labels={teams.trends.labels} series={teams.trends.soldCents} format={compact} />}
                <BarList title="Offers accepted by team over the period" data={teams.rows.slice(0, 10).map(t => ({ key: t.id, label: t.name, value: t.sold.current }))} />
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
