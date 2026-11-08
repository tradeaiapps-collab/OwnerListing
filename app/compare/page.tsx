"use client";
import { useEffect, useState } from "react";
import { MAX_COMPARE, parseCompareIds, type Comparison } from "../../src/domain/listing-compare";
import { photoUrl, type CardPhoto } from "../../src/domain/listing-photos";
import { readCompare, useCompare } from "../listings/compare-store";
import { ComparePicker } from "./compare-picker";
import { useSearchPersona } from "../listings/persona-context";
import { JSON_HEADERS } from "../listings/ui";
import "../styles/cards.css";
import "../styles/search.css";

type Card = { id: string; title: string; address: string; transactionType: "sale" | "rent" } & CardPhoto;
type Data = { listings: Card[]; comparison: Comparison };

/**
 * Side-by-side comparison of 2 to 4 listings (?ids=). Figures come from the listings; the best value on each row is marked.
 * Elena can word the summary, but the numbers are always the listings' own.
 */
export default function ComparePage() {
  const persona = useSearchPersona();
  const [ids, setIds] = useState<string[] | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [narration, setNarration] = useState("");
  const [asking, setAsking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const { replace } = useCompare();

  useEffect(() => {
    const fromUrl = parseCompareIds(new URLSearchParams(window.location.search).get("ids"));
    // No usable link: fall back to the listings picked on the browse page in this browser.
    const picked = readCompare().map(i => i.id);
    setIds(fromUrl ?? (picked.length >= 2 ? picked : []));
  }, []);

  useEffect(() => {
    if (ids === null) return;
    setData(null); setError(""); setNarration("");
    if (ids.length < 2) return;
    fetch(`/api/listings/compare?ids=${ids.join(",")}`)
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Could not load the comparison."); setData(d); })
      .catch((e: Error) => setError(e.message));
  }, [ids]);

  const go = (next: string[]) => {
    setIds(next); setChoosing(false);
    const u = new URL(window.location.href);
    u.searchParams.set("ids", next.join(","));
    window.history.pushState(null, "", u);
  };
  const change = () => {
    replace((data?.listings ?? []).map(l => ({ id: l.id, title: l.title })));
    setChoosing(true);
  };
  const drop = (id: string) => {
    const next = (ids ?? []).filter(x => x !== id);
    setIds(next);
    const u = new URL(window.location.href);
    u.searchParams.set("ids", next.join(","));
    window.history.replaceState(null, "", u);
  };

  async function ask() {
    if (!ids) return;
    setAsking(true);
    try {
      const r = await fetch("/api/search/assist", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ mode: "compare", ids }) });
      const d = await r.json();
      if (!r.ok) setError(d.error ?? "Could not get a summary.");
      else setNarration(d.narration ?? `${persona.name}'s written summaries are not switched on yet, so the facts above are the full summary.`);
    } catch { setError("Could not get a summary."); } finally { setAsking(false); }
  }

  const c = data?.comparison;
  return (
    <main className="cmp-page">
      <h1>Compare properties</h1>
      <p className="muted">Pick 2 to {MAX_COMPARE} properties and see them side by side.</p>
      {ids !== null && (ids.length < 2 || choosing) && <ComparePicker onCompare={go} />}
      {error && !choosing && <p role="alert">{error} <button type="button" className="secondary" onClick={change}>Choose again</button></p>}
      {ids !== null && ids.length >= 2 && !choosing && !data && !error && <p className="muted" role="status">Loading...</p>}
      {data && c && !choosing && (
        <>
          <section className="cmp-summary" aria-labelledby="cmp-sum-h">
            <h2 id="cmp-sum-h">Summary</h2>
            <p><button type="button" className="secondary" onClick={change}>Change properties</button></p>
            {c.highlights.length === 0 ? <p>{c.summary}</p> : <ul>{c.highlights.map(h => <li key={h}>{h}</li>)}</ul>}
            {narration && <p><strong>{persona.name}:</strong> {narration}</p>}
            <button type="button" className="secondary" disabled={asking} onClick={ask}>{asking ? `${persona.name} is writing...` : `Ask ${persona.name} to explain`}</button>
            <p><small className="muted">General information from the listings. Not a valuation or advice. Check details with the owners and a solicitor or conveyancer.</small></p>
          </section>
          <div className="cmp-scroll" tabIndex={0} role="region" aria-label="Comparison table">
            <table className="cmp-table">
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">Feature</span></th>
                  {data.listings.map(l => (
                    <th scope="col" key={l.id}>
                      <div className="cmp-head-card">
                        {l.cover && <img src={photoUrl(l.cover.id)} srcSet={l.cover.srcSet || undefined} sizes="(min-width: 960px) 20vw, 40vw" width={l.cover.width} height={l.cover.height} loading="lazy" alt="" />}
                        <a href={`/listings/${l.id}`}>{l.title}</a>
                        <small className="muted">{l.address}</small>
                        {ids!.length > 2 && <button type="button" className="secondary cmp-remove" onClick={() => drop(l.id)} aria-label={`Remove ${l.title} from comparison`}>Remove</button>}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.rows.map(r => (
                  <tr key={r.key}>
                    <th scope="row">{r.label}</th>
                    {r.values.map((v, i) => <td key={i} className={r.best.includes(i) ? "best" : undefined}>{v}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
