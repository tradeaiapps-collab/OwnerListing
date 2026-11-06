"use client";
import { useEffect, useState } from "react";
import { formatPrice } from "../../src/domain/listing-details";
import { MAX_COMPARE, MIN_COMPARE } from "../../src/domain/listing-compare";
import { useCompare } from "../listings/compare-store";

type Row = { id: string; title: string; address: string; transactionType: "sale" | "rent"; priceCents?: number; bedrooms?: number };

/**
 * Where the buyer chooses what to compare, without leaving the compare page:
 * four slots showing the picks (each removable), a search to add more, and a Compare button that wakes at 2.
 */
export function ComparePicker({ onCompare, compareLabel }: { onCompare: (ids: string[]) => void; compareLabel?: string }) {
  const { items, toggle, remove, clear, full } = useCompare();
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    const p = new URLSearchParams({ sort: "newest", page: String(page) });
    if (term) p.set("q", term);
    let live = true;
    setError("");
    fetch(`/api/listings?${p}`).then(r => r.json())
      .then(d => { if (!live) return; setRows(prev => (page > 1 && prev ? [...prev, ...(d.listings ?? [])] : d.listings ?? [])); setTotal(d.total ?? 0); })
      .catch(() => live && setError("Could not load listings."));
    return () => { live = false; };
  }, [term, page]);

  const ready = items.length >= MIN_COMPARE;
  const need = MIN_COMPARE - items.length;
  return (
    <section className="cmp-picker" aria-labelledby="cmp-pick-h">
      <h2 id="cmp-pick-h">Your comparison: {items.length} of {MAX_COMPARE} properties</h2>
      <ul className="cmp-slots" aria-label="Properties picked">
        {Array.from({ length: MAX_COMPARE }, (_, i) => {
          const it = items[i];
          return it ? (
            <li key={it.id} className="cmp-slot">
              <span className="cmp-name" title={it.title}>{it.title}</span>
              <button type="button" className="secondary cmp-x" onClick={() => remove(it.id)} aria-label={`Remove ${it.title} from comparison`}>&times;</button>
            </li>
          ) : <li key={`e${i}`} className="cmp-slot empty-slot">{i < MIN_COMPARE ? "Required: add a property" : "Optional: add another"}</li>;
        })}
      </ul>
      <div className="cmp-bar">
        <button type="button" disabled={!ready} onClick={() => onCompare(items.map(i => i.id))}>{compareLabel ?? `Compare ${ready ? items.length : ""}`.trim()}</button>
        {items.length > 0 && <button type="button" className="secondary" onClick={clear}>Clear all</button>}
        <span className="muted" role="status">{ready ? (full ? "Four picked, the most you can compare. Remove one to swap." : "Ready. Add up to " + (MAX_COMPARE - items.length) + " more, or compare now.") : `Add ${need} more ${need === 1 ? "property" : "properties"} to compare.`}</span>
      </div>
      <div className="cmp-find">
        <label htmlFor="cmp-search"><strong>Find properties to add</strong></label>
        <input id="cmp-search" type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Suburb, street or keyword" autoComplete="off" />
        {error && <p role="alert">{error}</p>}
        {rows === null && !error && <p className="muted" role="status">Loading...</p>}
        {rows && rows.length === 0 && <p className="empty">No published listings match. Try another word.</p>}
        {rows && rows.length > 0 && (
          <ul className="cmp-results">
            {rows.map(r => {
              const on = items.some(x => x.id === r.id);
              const blocked = full && !on;
              return (
                <li key={r.id} className={`cmp-result${on ? " picked" : ""}`}>
                  <div>
                    <strong>{r.title}</strong>
                    <small className="muted">{r.address}{r.priceCents !== undefined ? ` · ${formatPrice(r.priceCents, r.transactionType)}` : ""}{r.bedrooms !== undefined ? ` · ${r.bedrooms} bed` : ""}</small>
                  </div>
                  <button type="button" className={on ? "" : "secondary"} aria-pressed={on} disabled={blocked}
                    aria-label={`${on ? "Remove" : "Add"} ${r.title} ${on ? "from" : "to"} comparison`}
                    onClick={() => toggle({ id: r.id, title: r.title })}>{on ? "✓ Added" : blocked ? "Full" : "+ Add"}</button>
                </li>
              );
            })}
          </ul>
        )}
        {rows && rows.length < total && <button type="button" className="secondary" onClick={() => setPage(p => p + 1)}>Show more</button>}
      </div>
    </section>
  );
}
