"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import "../styles/agent-marketplace.css";
import "../styles/contractors.css";
import { Avatar, JSON_HEADERS, Stars, conNo, price, tradeName } from "./ui";

type Row = { contractorNo: number; name: string; headline: string; tradeLabel: string; verified: boolean; kinds: string[]; suburbs: string[]; fromPriceCents: number | null; ratingAvg: number | null; ratingCount: number; completed: number };
type Suggestion = { userId: string; contractorNo: number; name: string; ratingAvg: number | null; fromPriceCents: number | null; score: number; reasons: string[] };
const TRADES = [["", "All trades"], ["photographer", "Photographer"], ["inspector", "Building inspector"], ["pest_control", "Pest control"], ["other", "Other trades"]] as const;

export default function Contractors() {
  const [q, setQ] = useState({ trade: "", area: "", text: "" });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [listings, setListings] = useState<{ id: string; title: string }[]>([]);
  const [el, setEl] = useState({ listingId: "", kind: "photographer" });
  const [sug, setSug] = useState<Suggestion[] | null>(null);
  const [elMsg, setElMsg] = useState<{ ok: boolean; text: string; href?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (v: typeof q) => {
    setError(""); setRows(null);
    try {
      const p = new URLSearchParams(); if (v.trade) p.set("trade", v.trade); if (v.area.trim()) p.set("area", v.area.trim()); if (v.text.trim()) p.set("q", v.text.trim());
      const r = await fetch(`/api/contractors?${p}`);
      if (!r.ok) throw new Error();
      setRows((await r.json()).contractors);
    } catch { setError("Could not load contractors. Try again."); }
  }, []);
  useEffect(() => {
    void search({ trade: "", area: "", text: "" });
    void fetch("/api/listings/mine").then(async r => { if (r.ok) { const l = (await r.json()).listings; setListings(l); setEl(x => ({ ...x, listingId: l[0]?.id ?? "" })); } }).catch(() => undefined);
  }, [search]);

  async function suggest() {
    setBusy(true); setElMsg(null); setSug(null);
    try {
      const r = await fetch(`/api/listings/${el.listingId}/jobs/suggest?kind=${el.kind}`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) setSug(d.suggestions); else setElMsg({ ok: false, text: d.error ?? "Could not get suggestions." });
    } catch { setElMsg({ ok: false, text: "Could not get suggestions." }); } finally { setBusy(false); }
  }
  async function choose() {
    setBusy(true); setElMsg(null);
    try {
      const r = await fetch(`/api/listings/${el.listingId}/jobs/elena`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind: el.kind }) });
      const d = await r.json().catch(() => ({}));
      setElMsg(r.ok ? { ok: true, text: `Elena sent JOB-${d.job.jobNumber} to ${d.job.contractorName}. ${d.reasons.join(". ")}.`, href: `/jobs/${d.job.id}` } : { ok: false, text: d.error ?? "Elena could not choose." });
    } catch { setElMsg({ ok: false, text: "Elena could not choose." }); } finally { setBusy(false); }
  }

  return (
    <main className="ma cm">
      <header><h1>Find a contractor</h1><p className="muted" style={{ margin: 0 }}>Photographers, building inspectors, pest control and other trades. Prices are set by each contractor and you pay them directly.</p></header>

      {listings.length > 0 && (
        <section className="ma-section" aria-labelledby="cm-elena">
          <h2 id="cm-elena">Let Elena choose</h2>
          <p className="cm-note">Elena looks at who works near your listing, their rating, their price and how busy they are.</p>
          <div className="ma-filters">
            <label className="field"><span>Listing</span><select value={el.listingId} onChange={e => setEl({ ...el, listingId: e.target.value })}>{listings.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}</select></label>
            <label className="field"><span>Trade</span><select value={el.kind} onChange={e => setEl({ ...el, kind: e.target.value })}>{TRADES.filter(t => t[0]).map(t => <option key={t[0]} value={t[0]}>{t[1]}</option>)}</select></label>
            <div className="cm-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void suggest()}>Show Elena&apos;s picks</button><button type="button" disabled={busy} onClick={() => void choose()}>Let Elena choose for me</button></div>
          </div>
          {elMsg && <p role="status" className={elMsg.ok ? "ma-ok" : "ma-error"}>{elMsg.text} {elMsg.href && <a href={elMsg.href}>Open the job</a>}</p>}
          {sug && (sug.length === 0 ? <p className="ma-state">Nobody in your area takes this trade yet. Browse the list below.</p> : (
            <ul className="cm-suggest" aria-label="Elena's picks">{sug.map((s, i) => (
              <li key={s.userId}><div className="ma-head"><Avatar name={s.name} photoUrl={null} /><div><span className="cm-num">{i === 0 ? "Best match · " : ""}{conNo(s.contractorNo)}</span><h3><a href={`/contractors/${s.contractorNo}`}>{s.name}</a></h3></div></div>
                <ul className="reasons">{s.reasons.map(r => <li key={r}>{r}</li>)}</ul></li>
            ))}</ul>
          ))}
        </section>
      )}

      <form className="ma-filters" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); void search(q); }}>
        <label className="field"><span>Trade</span><select value={q.trade} onChange={e => setQ({ ...q, trade: e.target.value })}>{TRADES.map(t => <option key={t[0]} value={t[0]}>{t[1]}</option>)}</select></label>
        <label className="field"><span>Suburb or postcode</span><input value={q.area} onChange={e => setQ({ ...q, area: e.target.value })} maxLength={80} /></label>
        <label className="field"><span>Name</span><input value={q.text} onChange={e => setQ({ ...q, text: e.target.value })} maxLength={60} /></label>
        <div className="actions"><button type="submit">Search</button></div>
      </form>

      {error && <p className="ma-state ma-error" role="alert">{error}</p>}
      {!error && rows === null && <p className="ma-state" role="status">Loading…</p>}
      {rows && rows.length === 0 && <p className="ma-state">No contractors match yet. Try another suburb or trade.</p>}
      {rows && rows.length > 0 && (
        <ul className="ma-grid" aria-label="Contractors">{rows.map(c => (
          <li key={c.contractorNo} className="ma-card">
            <div className="ma-head"><Avatar name={c.name} photoUrl={null} /><div><span className="cm-num">{conNo(c.contractorNo)}</span><h2><a href={`/contractors/${c.contractorNo}`}>{c.name}</a></h2></div></div>
            {c.headline && <p className="ma-headline">{c.headline}</p>}
            <ul className="ma-tags">{c.kinds.map(k => <li key={k} className="ma-tag">{tradeName(k, c.tradeLabel)}</li>)}</ul>
            <div className="ma-meta"><Stars value={c.ratingAvg} count={c.ratingCount} />{c.verified && <span className="cm-badge">✓ Licence verified</span>}</div>
            <ul className="ma-meta"><li>{c.completed} job{c.completed === 1 ? "" : "s"} completed</li>{c.fromPriceCents !== null && <li>From {price(c.fromPriceCents)}</li>}{c.suburbs.length > 0 && <li>{c.suburbs.slice(0, 4).join(", ")}</li>}</ul>
            <div className="actions"><a className="button" href={`/contractors/${c.contractorNo}`}>View page and book</a></div>
          </li>
        ))}</ul>
      )}
    </main>
  );
}
