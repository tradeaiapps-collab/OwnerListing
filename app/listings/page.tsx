"use client";
import { useEffect, useState } from "react";
import { formatPrice } from "../../src/domain/listing-details";
import { BLANK_FILTERS, filterParams, filtersFromParams, type FilterForm } from "./url-params";
import { MapView } from "./map-view";
import type { CardPhoto } from "../../src/domain/listing-photos";
import { CardMedia } from "./card-media";
import "../styles/cards.css";

type Row = {
  id: string; title: string; address: string; jurisdiction: string; transactionType: "sale" | "rent"; useClass: string;
  propertyType: string; suburb?: string; postcode?: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number;
} & CardPhoto;

const BLANK = BLANK_FILTERS;
type Form = FilterForm;
const TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const COUNTS = ["1", "2", "3", "4", "5"];

function toParams(f: Form, sort: string, page: number): URLSearchParams {
  const p = filterParams(f);
  p.set("sort", sort);
  p.set("page", String(page));
  return p;
}

type View = "list" | "map";

export default function Listings() {
  const [form, setForm] = useState<Form>(BLANK);
  const [applied, setApplied] = useState<Form>(BLANK);
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(12);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("list");

  // Initial filters from the URL (home page search, shared links); invalid values are dropped.
  useEffect(() => {
    const init = { ...BLANK, ...filtersFromParams(new URLSearchParams(window.location.search)) };
    setForm(init);
    setApplied(init);
    if (new URLSearchParams(window.location.search).get("view") === "map") setView("map");
    setReady(true);
  }, []);

  // The chosen view goes in the address bar, so a shared or reloaded link opens the same view.
  const pick = (v: View) => {
    setView(v);
    const u = new URL(window.location.href);
    if (v === "map") u.searchParams.set("view", "map"); else u.searchParams.delete("view");
    window.history.replaceState(null, "", u);
  };

  useEffect(() => {
    if (!ready || view !== "list") return;
    setRows(null);
    setError("");
    fetch(`/api/listings?${toParams(applied, sort, page)}`)
      .then(r => r.json())
      .then(d => { setRows(d.listings ?? []); setTotal(d.total ?? 0); setPageSize(d.pageSize ?? 12); })
      .catch(() => setError("Could not load listings."));
  }, [ready, applied, sort, page, view]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const priceOk = form.transactionType !== "";
  const priceHint = form.transactionType === "rent" ? "per week" : "AUD";
  const rooms = (k: "minBedrooms" | "minBathrooms" | "minParking", label: string) => (
    <select aria-label={label} value={form[k]} onChange={set(k)}>
      <option value="">{label}</option>
      {COUNTS.map(c => <option key={c} value={c}>{c}+</option>)}
    </select>
  );

  return (
    <main>
      <div className="browse-head">
        <h1>Find a property</h1>
        <a className="button secondary" href="/listings/new">List your property</a>
      </div>
      <form className="search-form" aria-label="Search listings" onSubmit={e => { e.preventDefault(); setPage(1); setApplied(form); }}>
        <select aria-label="Sale or rent" value={form.transactionType} onChange={e => setForm(f => ({ ...f, transactionType: e.target.value, minPrice: "", maxPrice: "" }))}>
          <option value="">Sale or rent</option>
          <option value="sale">Sale</option>
          <option value="rent">Rent</option>
        </select>
        <select aria-label="Property type" value={form.propertyType} onChange={set("propertyType")}>
          <option value="">Any type</option>
          {TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
        </select>
        <input className="wide" aria-label="Suburb or postcode" placeholder="Suburb or postcode" maxLength={80} value={form.location} onChange={set("location")} />
        <input aria-label={`Minimum price (${priceHint})`} placeholder="Min price" inputMode="decimal" disabled={!priceOk} value={form.minPrice} onChange={set("minPrice")} />
        <input aria-label={`Maximum price (${priceHint})`} placeholder={priceOk ? `Max price (${priceHint})` : "Pick sale or rent for price"} inputMode="decimal" disabled={!priceOk} value={form.maxPrice} onChange={set("maxPrice")} />
        {rooms("minBedrooms", "Bedrooms")}
        {rooms("minBathrooms", "Bathrooms")}
        {rooms("minParking", "Parking")}
        <select aria-label="State" value={form.jurisdiction} onChange={set("jurisdiction")}>
          <option value="">All states</option>
          {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
        </select>
        <select aria-label="Use" value={form.useClass} onChange={set("useClass")}>
          <option value="">Residential or commercial</option>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </select>
        <div className="actions">
          <button type="submit">Search</button>
          <button type="button" className="secondary" onClick={() => { setForm(BLANK); setApplied(BLANK); setPage(1); }}>Clear</button>
        </div>
      </form>
      <div className="result-bar">
        <div className="view-toggle" role="group" aria-label="Show results as">
          <button type="button" className="secondary" aria-pressed={view === "list"} onClick={() => pick("list")}><span className="vt-icon vt-list" aria-hidden="true" />List</button>
          <button type="button" className="secondary" aria-pressed={view === "map"} onClick={() => pick("map")}><span className="vt-icon vt-map" aria-hidden="true" />Map</button>
        </div>
        {view === "list" && (
          <div className="result-bar-end">
            <span className="muted" role="status">{rows === null && !error ? "Loading..." : `${total} ${total === 1 ? "listing" : "listings"}`}</span>
            <select aria-label="Sort" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="bedrooms_desc">Most bedrooms</option>
            </select>
          </div>
        )}
      </div>
      {ready && view === "map" && <MapView filters={applied} />}
      {view === "list" && <>
      {error && <p role="alert">{error}</p>}
      {rows === null && !error && <ul className="lcards" aria-hidden="true">{[0, 1, 2].map(i => <li key={i} className="lcard lcard-skel"><div className="lcard-media" /><div className="lcard-body"><p className="lcard-price">&nbsp;</p></div></li>)}</ul>}
      {rows && rows.length === 0 && <p className="empty">No published listings match. Try fewer filters or a nearby suburb.</p>}
      {rows && rows.length > 0 && (
        <ul className="lcards">
          {rows.map(r => (
            <li key={r.id} className="lcard">
              <CardMedia photo={r} transactionType={r.transactionType} />
              <div className="lcard-body">
                {r.priceCents !== undefined && <p className="lcard-price">{formatPrice(r.priceCents, r.transactionType)}</p>}
                <h2 className="lcard-title"><a href={`/listings/${r.id}`}>{r.title}</a></h2>
                <p className="lcard-addr">{r.address}</p>
                <ul className="chips" aria-label="Features">
                  {r.bedrooms !== undefined && <li className="chip chip-bed">{r.bedrooms} bed</li>}
                  {r.bathrooms !== undefined && <li className="chip chip-bath">{r.bathrooms} bath</li>}
                  {r.parking !== undefined && <li className="chip chip-car">{r.parking} car</li>}
                </ul>
                <p className="lcard-meta">{r.suburb ? `${r.suburb} ${r.postcode ?? ""} · ` : ""}{r.jurisdiction} · {r.propertyType.charAt(0).toUpperCase() + r.propertyType.slice(1)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > pageSize && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
        </nav>
      )}
      </>}
    </main>
  );
}
