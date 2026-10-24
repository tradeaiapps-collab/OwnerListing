"use client";
import { useEffect, useState } from "react";

interface Row { id: string; title: string; address: string; jurisdiction: string; transactionType: string; useClass: string }

export default function Listings() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ jurisdiction: "", transactionType: "", useClass: "" });

  useEffect(() => {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
    setRows(null);
    setError("");
    fetch(`/api/listings?${q}`)
      .then(r => r.json())
      .then(d => setRows(d.listings ?? []))
      .catch(() => setError("Could not load listings."));
  }, [filters]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters(f => ({ ...f, [k]: e.target.value }));

  return (
    <main>
      <h1>Listings</h1>
      <div className="stack filters">
        <select aria-label="State" value={filters.jurisdiction} onChange={set("jurisdiction")}>
          <option value="">All states</option>
          {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
        </select>
        <select aria-label="Sale or rent" value={filters.transactionType} onChange={set("transactionType")}>
          <option value="">Sale or rent</option>
          <option value="sale">Sale</option>
          <option value="rent">Rent</option>
        </select>
        <select aria-label="Use" value={filters.useClass} onChange={set("useClass")}>
          <option value="">Residential or commercial</option>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </select>
      </div>
      {error && <p role="alert">{error}</p>}
      {!error && rows === null && <p className="muted" role="status">Loading...</p>}
      {rows && rows.length === 0 && <p className="empty">No published listings yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="card-list">
          {rows.map(r => (
            <li key={r.id}>
              <a href={`/listings/${r.id}`}><strong>{r.title}</strong></a>
              <div>{r.address}</div>
              <small className="muted">{r.jurisdiction} · {r.transactionType === "sale" ? "Sale" : "Rent"} · {r.useClass}</small>
            </li>
          ))}
        </ul>
      )}
      <p><a className="button" href="/listings/new">Create a listing</a></p>
    </main>
  );
}
