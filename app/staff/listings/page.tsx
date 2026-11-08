"use client";
import { useEffect, useState } from "react";
import { formatKpi, labelFor } from "../../../src/domain/admin-dashboard";
import type { ListingAction } from "../../../src/domain/admin-moderation";
import { BULK_ACTIONS, BULK_LABELS, BULK_MAX, type BulkAction } from "../../../src/domain/listing-bulk";
import { ReasonAction } from "../reason-action";
import { loadError } from "../staff-api";
import { BulkDialog, type Selection } from "./bulk-dialog";
import { VideoRefunds } from "./video-refunds";
import { StaffListingsMap } from "./listings-map";
import "../../styles/admin.css";

interface Row {
  id: string; title: string; suburb: string | null; jurisdiction: string; transactionType: string; propertyType: string; status: string; outcome: string | null;
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
  // Bulk selection: ticked rows, or every listing the applied filters match ("all").
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [canBulk, setCanBulk] = useState(false);
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [bulkChoice, setBulkChoice] = useState("");
  const [exportError, setExportError] = useState("");

  async function load(cursor?: string) {
    setError("");
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    if (cursor) p.set("cursor", cursor);
    else { setPicked(new Set()); setAllMatching(false); setApplied(Object.fromEntries(Object.entries(f).filter(([, v]) => v))); }
    const r = await fetch(`/api/staff/listings?${p}`).catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    const b = await r.json();
    setRows(prev => (cursor ? [...prev, ...b.listings] : b.listings));
    setNext(b.nextCursor);
    setCanBulk(b.canBulk === true);
    setLoaded(true);
  }
  useEffect(() => { void load(); }, []);

  const selection = (): Selection => (allMatching ? { filter: applied } : { ids: [...picked] });
  const count = allMatching ? null : picked.size;
  const allOnPage = rows.length > 0 && rows.every(r => picked.has(r.id));
  const togglePage = () => { setAllMatching(false); setPicked(allOnPage ? new Set() : new Set(rows.map(r => r.id))); };
  const toggleRow = (id: string) => { setAllMatching(false); setPicked(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  async function exportCsv() {
    setExportError("");
    const r = await fetch("/api/staff/listings/bulk/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(selection()) }).catch(() => null);
    if (!r || !r.ok) { setExportError(((await r?.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not export."); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url; a.download = `listings-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

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
      {rows.length > 0 && view === "table" && canBulk && (picked.size > 0 || allMatching) && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <strong className="bulk-count" aria-live="polite">{allMatching ? `All listings matching the filters (up to ${BULK_MAX})` : `${count} selected`}</strong>
          {!allMatching && allOnPage && (
            <button type="button" className="link-button" onClick={() => setAllMatching(true)}>Select all matching the filters</button>
          )}
          <label className="bulk-pick">Action
            <select value={bulkChoice} onChange={e => setBulkChoice(e.target.value)}>
              <option value="">Choose…</option>
              {BULK_ACTIONS.map(a => <option key={a} value={a}>{BULK_LABELS[a]}</option>)}
            </select>
          </label>
          <button type="button" disabled={!bulkChoice} onClick={() => setBulk(bulkChoice as BulkAction)}>Continue</button>
          <button type="button" className="secondary" onClick={() => void exportCsv()}>Export CSV</button>
          <button type="button" className="secondary" onClick={() => { setPicked(new Set()); setAllMatching(false); }}>Clear</button>
          {exportError && <span role="alert">{exportError}</span>}
        </div>
      )}
      {rows.length > 0 && view === "table" && (
        <div className="table-wrap"><table className="bulk-table">
          <thead><tr>{canBulk && <th scope="col" className="bulk-check"><input type="checkbox" aria-label="Select all listings on this page" checked={allOnPage || allMatching} onChange={togglePage} /></th>}<th scope="col">Listing</th><th scope="col">Where</th><th scope="col">Price</th><th scope="col">Offers</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} aria-selected={picked.has(r.id) || allMatching}>
                {canBulk && <td className="bulk-check"><input type="checkbox" aria-label={`Select ${r.title}`} checked={picked.has(r.id) || allMatching} disabled={allMatching} onChange={() => toggleRow(r.id)} /></td>}
                <td><strong>{r.transactionType === "sale" ? <a href={`/staff/listings/${r.id}`}>{r.title}</a> : r.title}</strong><br /><span className="muted">{r.propertyType} for {r.transactionType}, listed by {r.ownerType}, {new Date(r.createdAt).toLocaleDateString("en-AU")}</span></td>
                <td>{r.suburb ?? "No suburb"}, {r.jurisdiction}</td>
                <td>{r.priceCents === null ? "Not set" : `${formatKpi(r.priceCents, "cents")}${r.transactionType === "rent" ? " pw" : ""}`}</td>
                <td>{r.offers}</td>
                <td><span className={`status-pill ${pill(r.status)}`}>{labelFor(r.status)}</span>{r.outcome && <> <span className="status-pill">{labelFor(r.outcome)}</span></>}{r.lastReason && <><br /><span className="muted">Last staff reason: {r.lastReason}</span></>}</td>
                <td>
                  <div className="row-actions">
                    {r.status === "published" && <a href={`/listings/${r.id}`} target="_blank" rel="noreferrer">View</a>}
                    {r.actions.map(a => <ReasonAction key={a.action} label={a.label} action={a.action} danger={a.action === "suspend"} url={`/api/staff/listings/${r.id}/action`} onDone={() => void load()} />)}
                  </div>
                  <VideoRefunds listingId={r.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {bulk && <BulkDialog action={bulk} selection={selection()} onClose={() => setBulk(null)} onDone={() => { setBulk(null); setBulkChoice(""); void load(); }} />}
      {next && <button type="button" className="secondary" onClick={() => void load(next)}>Load more</button>}
    </main>
  );
}
