"use client";
import { useEffect, useState } from "react";
import { dollarsToCents, formatPrice } from "../../src/domain/listing-details";
import { filtersFromParams } from "./url-params";
import "../styles/cards.css";

interface Row {
  id: string; title: string; address: string; jurisdiction: string; transactionType: "sale" | "rent"; useClass: string;
  propertyType: string; suburb?: string; postcode?: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number;
}

const BLANK = { jurisdiction: "", transactionType: "", useClass: "", propertyType: "", location: "", minPrice: "", maxPrice: "", minBedrooms: "", minBathrooms: "", minParking: "" };
type Form = typeof BLANK;
const TYPES = ["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"];
const COUNTS = ["1", "2", "3", "4", "5"];

/** Form values to API parameters. Price fields are dollars in the form and cents in the API; only used with sale or rent. */
function toParams(f: Form, sort: string, page: number): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ["jurisdiction", "transactionType", "useClass", "propertyType", "minBedrooms", "minBathrooms", "minParking"] as const) if (f[k]) p.set(k, f[k]);
  const loc = f.location.trim();
  if (loc) p.set(/^\d{4}$/.test(loc) ? "postcode" : "suburb", loc);
  if (f.transactionType) {
    const lo = f.minPrice ? dollarsToCents(f.minPrice) : undefined;
    const hi = f.maxPrice ? dollarsToCents(f.maxPrice) : undefined;
    if (lo !== undefined) p.set("minPriceCents", String(lo));
    if (hi !== undefined) p.set("maxPriceCents", String(hi));
  }
  p.set("sort", sort);
  p.set("page", String(page));
  return p;
}

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

  // Initial filters from the URL (home page search, shared links); invalid values are dropped.
  useEffect(() => {
    const init = { ...BLANK, ...filtersFromParams(new URLSearchParams(window.location.search)) };
    setForm(init);
    setApplied(init);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    setRows(null);
    setError("");
    fetch(`/api/listings?${toParams(applied, sort, page)}`)
      .then(r => r.json())
      .then(d => { setRows(d.listings ?? []); setTotal(d.total ?? 0); setPageSize(d.pageSize ?? 12); })
      .catch(() => setError("Could not load listings."));
  }, [ready, applied, sort, page]);

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
        <span className="muted" role="status">{rows === null && !error ? "Loading..." : `${total} ${total === 1 ? "listing" : "listings"}`}</span>
        <select aria-label="Sort" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}>
          <option value="newest">Newest</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
          <option value="bedrooms_desc">Most bedrooms</option>
        </select>
      </div>
      {error && <p role="alert">{error}</p>}
      {rows === null && !error && <ul className="lcards" aria-hidden="true">{[0, 1, 2].map(i => <li key={i} className="lcard lcard-skel"><div className="lcard-media" /><div className="lcard-body"><p className="lcard-price">&nbsp;</p></div></li>)}</ul>}
      {rows && rows.length === 0 && <p className="empty">No published listings match. Try fewer filters or a nearby suburb.</p>}
      {rows && rows.length > 0 && (
        <ul className="lcards">
          {rows.map(r => (
            <li key={r.id} className="lcard">
              <div className="lcard-media"><span className="lcard-tag">{r.transactionType === "sale" ? "For sale" : "For rent"}</span></div>
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
    </main>
  );
}
