"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import { MAX_COMPARE, PERFORMANCE_PERIODS, type DateRange, type OwnerAgentRow } from "../../../src/domain/agent-performance";
import { METRIC_ROWS, Rating } from "../../agent-performance-ui";
import "../../styles/agent-performance.css";

type Comment = { rating: number; comment: string; month: string };
interface Data { range: DateRange; agents: OwnerAgentRow[]; compare: OwnerAgentRow[]; comments: Record<string, Comment[]>; specialties: string[] }

/** Owners choosing an agent: marketplace agents with their record, search, favourites and a side-by-side comparison of up to three. */
export default function OwnerAgentPerformance() {
  const [f, setF] = useState({ q: "", area: "", specialty: "", available: false, days: "180" });
  const [data, setData] = useState<Data | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (v: typeof f, ids: string[]) => {
    setBusy(true); setError("");
    const p = new URLSearchParams({ days: v.days });
    if (v.q) p.set("q", v.q);
    if (v.area) p.set("area", v.area);
    if (v.specialty) p.set("specialty", v.specialty);
    if (v.available) p.set("available", "1");
    if (ids.length) p.set("compare", ids.join(","));
    try {
      const r = await fetch(`/api/owner/agent-performance?${p}`);
      if (r.status === 401) return setError("Sign in as an owner to compare agents.");
      if (r.status === 403) return setError("Agent performance is for owners.");
      if (!r.ok) throw new Error();
      setData(await r.json());
    } catch { setError("Could not load agents."); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(f, picked); }, []);

  function togglePick(id: string) {
    const next = picked.includes(id) ? picked.filter(x => x !== id) : picked.length < MAX_COMPARE ? [...picked, id] : picked;
    setPicked(next); void load(f, next);
  }
  async function toggleFavorite(a: OwnerAgentRow) {
    setMsg("");
    try {
      const r = await fetch("/api/owner/agent-performance/favorites", { method: a.favorite ? "DELETE" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: a.agentId }) });
      if (!r.ok) throw new Error();
      setMsg(a.favorite ? `${a.name} removed from favourites.` : `${a.name} added to favourites.`);
      await load(f, picked);
    } catch { setMsg("Could not update favourites."); }
  }

  return (
    <main className="ap">
      <div>
        <h1>Agent performance</h1>
        <p className="ap-lead">How marketplace agents have done on the platform: time to sale, sales per month, price against asking, fall-through rate and buyer ratings. Choose up to {MAX_COMPARE} to compare.</p>
      </div>
      <form className="ap-filters" onSubmit={e => { e.preventDefault(); void load(f, picked); }}>
        <label>Name<input value={f.q} maxLength={80} onChange={e => setF({ ...f, q: e.target.value })} /></label>
        <label>Location<input value={f.area} maxLength={80} placeholder="Suburb" onChange={e => setF({ ...f, area: e.target.value })} /></label>
        <label>Specialty
          <select value={f.specialty} onChange={e => setF({ ...f, specialty: e.target.value })}>
            <option value="">Any</option>
            {(data?.specialties ?? []).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Period
          <select value={f.days} onChange={e => setF({ ...f, days: e.target.value })}>
            {PERFORMANCE_PERIODS.map(d => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </label>
        <label className="ap-check"><input type="checkbox" checked={f.available} onChange={e => setF({ ...f, available: e.target.checked })} />Taking new clients</label>
        <div className="actions"><button type="submit" disabled={busy}>{busy ? "Loading…" : "Search"}</button></div>
      </form>
      {error && <p role="alert" className="ap-error">{error} {error.startsWith("Sign in") && <a href="/login?as=owner">Sign in</a>}</p>}
      {msg && <p role="status" className="ap-ok">{msg}</p>}
      {!data && !error && <p className="ap-state" role="status">Loading agents…</p>}

      {data && data.compare.length >= 2 && (
        <section className="ap-section" aria-labelledby="cmp-h">
          <h2 id="cmp-h">Side by side</h2>
          <div className="ap-table-wrap">
            <table className="ap-table compact">
              <thead><tr><th scope="col">Measure</th>{data.compare.map(a => <th key={a.agentId} scope="col" className="num">{a.name}</th>)}</tr></thead>
              <tbody>
                {METRIC_ROWS.map(m => <tr key={m.key}><th scope="row">{m.label}</th>{data.compare.map(a => <td key={a.agentId} className="num">{m.text(a.metrics)}</td>)}</tr>)}
                <tr><th scope="row">Buyer rating</th>{data.compare.map(a => <td key={a.agentId} className="num">{a.metrics.satisfaction !== undefined ? `${a.metrics.satisfaction} (${a.metrics.ratingCount})` : "–"}</td>)}</tr>
                <tr><th scope="row">Active listings</th>{data.compare.map(a => <td key={a.agentId} className="num">{a.activeListings}</td>)}</tr>
              </tbody>
            </table>
          </div>
          {data.compare.map(a => (data.comments[a.agentId] ?? []).length > 0 && (
            <div key={a.agentId}><h3>What buyers said about {a.name}</h3>
              <ul className="ap-quotes">{data.comments[a.agentId]!.map((c, i) => <li key={i}><span>{"★".repeat(c.rating)} <span className="muted">{c.month}</span></span><p>{c.comment}</p></li>)}</ul>
            </div>
          ))}
        </section>
      )}
      {data && picked.length === 1 && <p className="muted">Pick one more agent to compare.</p>}

      {data && data.agents.length === 0 && <div className="ap-state"><p>No agents match. Try a different suburb or specialty.</p></div>}
      {data && data.agents.length > 0 && (
        <ul className="ap-grid">
          {data.agents.map(a => (
            <li key={a.agentId} className="ap-card">
              <div className="ap-card-head">
                <div><h2><a href={`/marketplace/agents/${a.agentId}`}>{a.name}</a></h2>{a.headline && <p className="muted" style={{ margin: 0 }}>{a.headline}</p>}</div>
                <button type="button" className="ap-fav" aria-pressed={a.favorite} aria-label={a.favorite ? `Remove ${a.name} from favourites` : `Add ${a.name} to favourites`} onClick={() => void toggleFavorite(a)}>{a.favorite ? "★" : "☆"}</button>
              </div>
              <Rating m={a.metrics} />
              <dl className="ap-stats">
                {METRIC_ROWS.map(m => <Fragment key={m.key}><dt>{m.label}</dt><dd>{m.text(a.metrics)}</dd></Fragment>)}
                <dt>Active listings</dt><dd>{a.activeListings}</dd>
              </dl>
              {a.areas.length > 0 && <p className="muted" style={{ margin: 0 }}>{a.areas.join(", ")}</p>}
              {a.specialties.length > 0 && <ul className="ap-tags">{a.specialties.slice(0, 4).map(s => <li key={s} className="ap-tag">{s}</li>)}</ul>}
              <div className="ap-actions">
                <label className="ap-check"><input type="checkbox" checked={picked.includes(a.agentId)} disabled={!picked.includes(a.agentId) && picked.length >= MAX_COMPARE} onChange={() => togglePick(a.agentId)} />Compare</label>
                <a className="button secondary" href={`/marketplace/agents/${a.agentId}`}>{a.acceptingNew ? "View profile and book" : "View profile"}</a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && <p className="muted">Figures cover {data.range.from} to {data.range.to}. Ratings come only from buyers whose offer was accepted; buyers are never named.</p>}
    </main>
  );
}
