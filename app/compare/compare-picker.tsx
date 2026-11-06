"use client";
import { useEffect, useState } from "react";
import { formatPrice } from "../../src/domain/listing-details";
import { MAX_COMPARE, MIN_COMPARE } from "../../src/domain/listing-compare";
import type { CardPhoto } from "../../src/domain/listing-photos";
import { CardMedia } from "../listings/card-media";
import { useCompare } from "../listings/compare-store";

type Row = { id: string; title: string; address: string; transactionType: "sale" | "rent"; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number } & CardPhoto;

/**
 * Choose 2 to 4 properties without leaving the Compare page: search, press "Add to compare" on cards,
 * watch the numbered slots fill, then press Compare (enabled from 2).
 */
export function ComparePicker({ onCompare }: { onCompare: (ids: string[]) => void }) {
  const { items, toggle, remove, clear, full } = useCompare();
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(12);
  const [error, setError] = useState("");

  useEffect(() => {
    setRows(null); setError("");
    const p = new URLSearchParams({ sort: "newest", page: String(page) });
    if (applied.trim()) p.set("q", applied.trim());
    fetch(`/api/listings?${p}`)
      .then(r => r.json())
      .then(d => { setRows(d.listings ?? []); setTotal(d.total ?? 0); setPageSize(d.pageSize ?? 12); })
      .catch(() => setError("Could not load listings."));
  }, [applied, page]);

  const ready = items.length >= MIN_COMPARE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const slots = Array.from({ length: MAX_COMPARE }, (_, i) => items[i]);

  return (
    <section aria-labelledby="cmp-pick-h">
      <div className="cmp-picker-bar">
        <h2 id="cmp-pick-h">Your comparison: {items.length} of {MAX_COMPARE} selected</h2>
        <ul className="cmp-slots">
          {slots.map((it, i) => it
            ? <li key={it.id} className="cmp-slot filled"><span className="cmp-name">{it.title}</span><button type="button" className="secondary cmp-x" onClick={() => remove(it.id)} aria-label={`Remove ${it.title} from comparison`}>&times;</button></li>
            : <li key={`e${i}`} className="cmp-slot">Property {i + 1}{i < MIN_COMPARE ? "" : " (optional)"}</li>)}
        </ul>
      </div>
      <form className="cmp-search" role="search" onSubmit={e => { e.preventDefault(); setPage(1); setApplied(q); }}>
        <input type="search" value={q} onChange={e => setQ(e.target.value)} aria-label="Search listings by suburb, address or keyword" placeholder="Search by suburb, address or keyword" />
        <button type="submit">Search</button>
        {applied && <button type="button" className="secondary" onClick={() => { setQ(""); setApplied(""); setPage(1); }}>Clear search</button>}
      </form>
      {error && <p role="alert">{error}</p>}
      {rows === null && !error && <p className="muted" role="status">Loading listings...</p>}
      {rows && rows.length === 0 && <p className="empty">No published listings match. Try a different search.</p>}
      {rows && rows.length > 0 && (
        <ul className="lcards">
          {rows.map(r => {
            const on = items.some(x => x.id === r.id);
            const blocked = full && !on;
            return (
              <li key={r.id} className={`lcard${on ? " picked" : ""}`}>
                <CardMedia photo={r} transactionType={r.transactionType} />
                <div className="lcard-body">
                  {r.priceCents !== undefined && <p className="lcard-price">{formatPrice(r.priceCents, r.transactionType)}</p>}
                  <h3 className="lcard-title"><a href={`/listings/${r.id}`} target="_blank" rel="noopener">{r.title}</a></h3>
                  <p className="lcard-addr">{r.address}</p>
                  <ul className="chips" aria-label="Features">
                    {r.bedrooms !== undefined && <li className="chip chip-bed">{r.bedrooms} bed</li>}
                    {r.bathrooms !== undefined && <li className="chip chip-bath">{r.bathrooms} bath</li>}
                    {r.parking !== undefined && <li className="chip chip-car">{r.parking} car</li>}
                  </ul>
                  <button type="button" className={`cmp-add${on ? "" : " secondary"}`} aria-pressed={on} disabled={blocked} onClick={() => toggle({ id: r.id, title: r.title })}>
                    {on ? "✓ Added. Tap to remove" : blocked ? "Comparison full" : "+ Add to compare"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {total > pageSize && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
        </nav>
      )}
      <aside className="cmp-tray" aria-label="Compare selection">
        <div className="cmp-actions">
          <span className="muted" role="status">{ready ? (full ? "Comparison is full. Remove one to swap." : "Ready. Add up to 2 more, or compare now.") : `Add ${MIN_COMPARE - items.length} more ${MIN_COMPARE - items.length === 1 ? "property" : "properties"} to compare.`}</span>
          {items.length > 0 && <button type="button" className="secondary" onClick={clear}>Clear all</button>}
          <button type="button" disabled={!ready} onClick={() => onCompare(items.map(i => i.id))}>{ready ? `Compare ${items.length} properties` : "Compare"}</button>
        </div>
      </aside>
    </section>
  );
}
