"use client";
import { useEffect, useState } from "react";
import { formatKpi, labelFor } from "../../../src/domain/admin-dashboard";
import type { ListingAction } from "../../../src/domain/admin-moderation";
import { ReasonAction } from "../reason-action";
import { loadError } from "../staff-api";
import { StaffListingsMap } from "./listings-map";
import "../../styles/admin.css";

interface Row {
  id: string; title: string; suburb: string | null; jurisdiction: string; transactionType: string; propertyType: string; status: string;
  priceCents: number | null; createdAt: string; ownerType: string; offers: number; lastReason: string | null; latitude: number | null; longitude: number | null; actions: { action: ListingAction; label: string }[];
}
const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
const STATUSES = ["published", "suspended", "pending_review", "draft", "withdrawn", "archived"];
const pill = (s: string) => (s === "published" ? "good" : s === "suspended" ? "bad" : s === "pending_review" ? "warn" : "");

/** Every listing: search, filter, and suspend, reinstate or send back with a reason. */
export default function ListingModeration() {
  const [f, setF] = useState({ q: "", status: "", jurisdiction: "", transactionType: "" });
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"table" | "map">("table");

  async function load(cursor?: string) {
    setError("");
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (cursor) p.set("cursor", cursor);
    const r = await fetch(`/api/staff/listings?${p}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const b = await r.json();
    setRows(prev => (cursor ? [...prev, ...b.listings] : b.listings));
    setNext(b.nextCursor);
    setLoaded(true);
  }
  useEffect(() => { void load(); }, []);

  const sel = (k: keyof typeof f, label: string, opts: string[], show = labelFor) => (
    <label>{label}
      <select value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })}>
        <option value="">All</option>{opts.map(o => <option key={o} value={o}>{show(o)}</option>)}
      </select>
    </label>
  );

  return (
    <main className="admin-page">
      <h1>Listing moderation</h1>
      <p><a href="/staff/dashboard">Back to the admin dashboard</a></p>
      <p className="muted">
        Suspending hides a live listing from search and its public page at once. Reinstating runs the same publish checks the owner faces, so a
        listing that no longer passes them stays suspended. Listings go live only through those checks; staff cannot approve past them.
      </p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(); }}>
        <label>Search <input value={f.q} placeholder="Title, address, suburb, postcode or id" onChange={e => setF({ ...f, q: e.target.value })} /></label>
        {sel("status", "Status", STATUSES)}
        {sel("jurisdiction", "State", STATES, s => s)}
        {sel("transactionType", "Sale or rent", ["sale", "rent"], s => (s === "sale" ? "Sale" : "Rent"))}
        <button type="submit">Search</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {loaded && rows.length === 0 && <p className="empty">No listings match.</p>}
      {rows.length > 0 && (
        <div className="view-toggle" role="group" aria-label="Show as">
          <button type="button" className="secondary" aria-pressed={view === "table"} onClick={() => setView("table")}><span className="vt-icon vt-list" aria-hidden="true" />Table</button>
          <button type="button" className="secondary" aria-pressed={view === "map"} onClick={() => setView("map")}><span className="vt-icon vt-map" aria-hidden="true" />Map</button>
        </div>
      )}
      {rows.length > 0 && view === "map" && <StaffListingsMap rows={rows} />}
      {rows.length > 0 && view === "table" && (
        <div className="table-wrap"><table>
          <thead><tr><th scope="col">Listing</th><th scope="col">Where</th><th scope="col">Price</th><th scope="col">Offers</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><strong>{r.title}</strong><br /><span className="muted">{r.propertyType} for {r.transactionType}, listed by {r.ownerType}, {new Date(r.createdAt).toLocaleDateString("en-AU")}</span></td>
                <td>{r.suburb ?? "No suburb"}, {r.jurisdiction}</td>
                <td>{r.priceCents === null ? "Not set" : `${formatKpi(r.priceCents, "cents")}${r.transactionType === "rent" ? " pw" : ""}`}</td>
                <td>{r.offers}</td>
                <td><span className={`status-pill ${pill(r.status)}`}>{labelFor(r.status)}</span>{r.lastReason && <><br /><span className="muted">Last staff reason: {r.lastReason}</span></>}</td>
                <td>
                  <div className="row-actions">
                    {r.status === "published" && <a href={`/listings/${r.id}`} target="_blank" rel="noreferrer">View</a>}
                    {r.actions.map(a => <ReasonAction key={a.action} label={a.label} action={a.action} danger={a.action === "suspend"} url={`/api/staff/listings/${r.id}/action`} onDone={() => void load()} />)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {next && <button type="button" className="secondary" onClick={() => void load(next)}>Load more</button>}
    </main>
  );
}
