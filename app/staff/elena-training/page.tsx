"use client";
import { useEffect, useState } from "react";
import type { GroupStat, Health } from "../../../src/domain/elena-learning";
import { loadError } from "../staff-api";

interface Experiment { key: string; feature: string; status: string; winner?: string; note: string; arms: { arm: string; n: number; successRate: number }[] }
interface Config { version: number; status: string; trainedOn: number; notes: string[]; createdAt: string }
interface Payload {
  health: Health; active: { trainedOn: number } | null; differentiators: string[]; byFeature: GroupStat[]; byType: GroupStat[]; byRegion: GroupStat[]; byRole: GroupStat[];
  configs: Config[]; experiments: Experiment[]; features: string[];
}
const pct = (n?: number) => (n === undefined ? "–" : `${Math.round(n * 100)}%`);

function Table({ title, rows }: { title: string; rows: GroupStat[] }) {
  return (
    <>
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="muted">No suggestions recorded yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Group</th><th scope="col" className="num">Suggestions</th><th scope="col" className="num">Reacted to</th><th scope="col" className="num">Accepted</th><th scope="col" className="num">Success</th></tr></thead>
          <tbody>{rows.map(r => <tr key={r.key}><td>{r.key}</td><td className="num">{r.n}</td><td className="num">{r.reacted}</td><td className="num">{pct(r.reacted ? r.acceptanceRate : undefined)}</td><td className="num">{pct(r.meanSuccess)}</td></tr>)}</tbody>
        </table></div>
      )}
    </>
  );
}

/** How well Elena's suggestions work and what she has learned. Read for everyone with the sales report; outcomes, activation and tests need more. */
export default function ElenaTraining() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [o, setO] = useState({ settlementId: "", outcome: "settled", days: "", price: "", negotiations: "", satisfaction: "" });
  const [x, setX] = useState({ key: "", feature: "negotiation_coach", arms: "a,b" });

  async function load() {
    const r = await fetch("/api/staff/elena-training").catch(() => null);
    if (!r) { setError(loadError(0)); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    setError(""); setData(await r.json());
  }
  useEffect(() => { void load(); }, []);

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true); setMsg("");
    const r = await fetch("/api/staff/elena-training", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (!r) { setMsg(loadError(0)); return; }
    if (!r.ok) { setMsg((await r.json().catch(() => ({}))).error ?? loadError(r.status)); return; }
    setMsg(done); await load();
  }
  const h = data?.health;

  return (
    <main className="admin-page">
      <h1>Elena training</h1>
      <p><a href="/staff/elena-insights">Elena's platform insights</a> · <a href="/staff/ai">AI engine</a></p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p className="muted" role="status">Loading…</p>}
      {msg && <p role="status">{msg}</p>}
      {data && h && (
        <>
          <h2>Model health</h2>
          <div className="table-wrap"><table>
            <thead><tr><th scope="col">Measure</th><th scope="col" className="num">Value</th><th scope="col">Meaning</th></tr></thead>
            <tbody>
              <tr><td>Suggestions recorded</td><td className="num">{h.suggestions}</td><td>Everything Elena has suggested since the platform started recording.</td></tr>
              <tr><td>Feedback captured</td><td className="num">{pct(h.captureRate)}</td><td>{h.captureOk ? "On target (80% or more)." : "Below the 80% target. Prompts and automatic capture should close the gap."}</td></tr>
              <tr><td>Acceptance</td><td className="num">{pct(h.acceptanceRate)}</td><td>{h.acceptanceChange === undefined ? "Not enough earlier data for a trend." : `${h.acceptanceChange > 0 ? "+" : ""}${Math.round(h.acceptanceChange * 100)} points against the 30 days before.`}</td></tr>
              <tr><td>Deals settled</td><td className="num">{pct(h.settlementRate)}</td><td>Of deals with a recorded outcome{h.medianDaysToSettlement === undefined ? "." : `; median ${h.medianDaysToSettlement} days to settle.`}</td></tr>
              <tr><td>Rating of Elena</td><td className="num">{h.meanRating === undefined ? "–" : h.meanRating.toFixed(1)}</td><td>Out of 5, from optional ratings.</td></tr>
              <tr><td>"Did it work?" yes</td><td className="num">{pct(h.helpfulYesRate)}</td><td>Of people who answered.</td></tr>
            </tbody>
          </table></div>

          <h2>What makes this Elena different</h2>
          <ul>{data.differentiators.map(d => <li key={d}>{d}</li>)}</ul>
          <p className="muted">Learning here is statistical: weights for which suggestions to lead with, by type and state. It does not retrain a language model, and it never changes the safety rules.</p>

          <Table title="By feature" rows={data.byFeature} />
          <Table title="By suggestion type" rows={data.byType} />
          <Table title="By state" rows={data.byRegion} />
          <Table title="By role" rows={data.byRole} />

          <h2>Learned settings</h2>
          {data.configs.length === 0 ? <p className="muted">Nothing proposed yet. The monthly job proposes a version once 30 suggestions have an outcome.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th scope="col" className="num">Version</th><th scope="col">Status</th><th scope="col" className="num">Trained on</th><th scope="col">Notes</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
              <tbody>{data.configs.map(c => (
                <tr key={c.version}><td className="num">{c.version}</td><td>{c.status}</td><td className="num">{c.trainedOn}</td><td>{c.notes.join(" ") || "–"}</td>
                  <td>{c.status === "proposed" && <button type="button" disabled={busy} onClick={() => void post({ action: "activate", version: c.version }, `Version ${c.version} is active.`)}>Activate</button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}

          <h2>A/B tests</h2>
          {data.experiments.length === 0 ? <p className="muted">No tests yet.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th scope="col">Test</th><th scope="col">Feature</th><th scope="col">Status</th><th scope="col">Arms (reacted, accepted)</th><th scope="col">Result</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
              <tbody>{data.experiments.map(e => (
                <tr key={e.key}><td>{e.key}</td><td>{e.feature}</td><td>{e.status}</td><td>{e.arms.map(a => `${a.arm}: ${a.n}, ${pct(a.successRate)}`).join(" · ")}</td><td>{e.note}</td>
                  <td>{e.status === "running" && <button type="button" className="secondary" disabled={busy} onClick={() => void post({ action: "stop_experiment", key: e.key }, "Test stopped.")}>Stop</button>}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          <form className="filters" onSubmit={e => { e.preventDefault(); void post({ action: "experiment", key: x.key, feature: x.feature, arms: x.arms.split(",").map(s => s.trim()) }, "Test started."); }}>
            <label>Key <input value={x.key} onChange={e => setX({ ...x, key: e.target.value })} required pattern="[a-z0-9_]{3,40}" /></label>
            <label>Feature <select value={x.feature} onChange={e => setX({ ...x, feature: e.target.value })}>{data.features.map(f => <option key={f}>{f}</option>)}</select></label>
            <label>Arms (comma separated) <input value={x.arms} onChange={e => setX({ ...x, arms: e.target.value })} required /></label>
            <button type="submit" disabled={busy}>Start test</button>
          </form>

          <h2>Record a deal outcome</h2>
          <p className="muted">Settled and fallen-through deals are picked up automatically. Use this for what is not captured: final price, days to settle, negotiation rounds, satisfaction.</p>
          <form className="filters" onSubmit={e => {
            e.preventDefault();
            void post({
              action: "outcome", settlementId: o.settlementId.trim(), outcome: o.outcome,
              ...(o.days ? { timeToSettlementDays: Number(o.days) } : {}), ...(o.price ? { finalPriceCents: Math.round(Number(o.price) * 100) } : {}),
              ...(o.negotiations ? { negotiationCount: Number(o.negotiations) } : {}), ...(o.satisfaction ? { userSatisfaction: Number(o.satisfaction) } : {})
            }, "Outcome saved.");
          }}>
            <label>Settlement ID <input value={o.settlementId} onChange={e => setO({ ...o, settlementId: e.target.value })} required /></label>
            <label>Outcome <select value={o.outcome} onChange={e => setO({ ...o, outcome: e.target.value })}><option value="settled">Settled</option><option value="fell_through">Fell through</option></select></label>
            <label>Days to settle <input type="number" min={0} value={o.days} onChange={e => setO({ ...o, days: e.target.value })} /></label>
            <label>Final price ($) <input type="number" min={1} value={o.price} onChange={e => setO({ ...o, price: e.target.value })} /></label>
            <label>Negotiation rounds <input type="number" min={0} value={o.negotiations} onChange={e => setO({ ...o, negotiations: e.target.value })} /></label>
            <label>Satisfaction (1-5) <input type="number" min={1} max={5} value={o.satisfaction} onChange={e => setO({ ...o, satisfaction: e.target.value })} /></label>
            <button type="submit" disabled={busy}>Save outcome</button>
          </form>
        </>
      )}
    </main>
  );
}
