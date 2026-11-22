"use client";
import { useEffect, useState } from "react";
import { AMENITY_LABELS, formatPrice, isAmenity } from "../../src/domain/listing-details";
import { parseSearchQuery } from "../../src/domain/listing-search";
import { BLANK_FILTERS, filterParams, filtersFromParams, formFromQuery, type FilterForm } from "./url-params";
import { CompareToggle, CompareTray } from "./compare-tray";
import { BuyerAdvisor } from "./buyer-advisor";
import { ElenaSearch } from "./elena-search";
import { MoreFilters } from "./search-extras";
import { SaveSearch } from "./save-search";
import { MapView } from "./map-view";
import type { CardPhoto } from "../../src/domain/listing-photos";
import { CardMedia } from "./card-media";
import "../styles/cards.css";
import "../styles/search.css";

type Row = {
  id: string; title: string; address: string; jurisdiction: string; transactionType: "sale" | "rent"; useClass: string;
  propertyType: string; suburb?: string; postcode?: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number;
  amenities?: string[]; distanceKm?: number;
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

/** Only the filters that have a value, so an empty one never wipes a filter read from a home page link. */
const definedOnly = (f: FilterForm): Partial<FilterForm> => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) as Partial<FilterForm>;

/** The applied filters in words, so the buyer sees what the results are narrowed by. */
function describeFilters(f: FilterForm): string[] {
  const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
  return [
    f.transactionType === "sale" ? "Buy" : f.transactionType === "rent" ? "Rent" : "", f.useClass && cap(f.useClass), f.propertyType && cap(f.propertyType), f.jurisdiction,
    f.location, f.minPrice && `From $${f.minPrice}`, f.maxPrice && `Up to $${f.maxPrice}`, f.minBedrooms && `${f.minBedrooms}+ bed`, f.minBathrooms && `${f.minBathrooms}+ bath`,
    f.minParking && `${f.minParking}+ parking`, f.amenities && f.amenities.split(",").filter(isAmenity).map(a => AMENITY_LABELS[a]).join(", "), f.q && `"${f.q}"`,
    f.lat && f.radiusKm && `Within ${f.radiusKm} km`
  ].filter((x): x is string => Boolean(x));
}

/** The filters the buyer advisor owns; her answers replace these and leave the rest (words, distance, bathrooms) alone. */
const ADVISOR_KEYS = ["transactionType", "minPriceCents", "maxPriceCents", "propertyType", "minBedrooms", "jurisdiction", "suburb", "postcode", "amenities"];

const queryString = (f: FilterForm) => filterParams(f).toString();

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
  const [fromSaved, setFromSaved] = useState(false);
  const [view, setView] = useState<View>("list");
  const [projects, setProjects] = useState<Array<{ id: string; title: string; location: string }>>([]);

  // Initial filters from the URL (home page search, shared links); invalid values are dropped.
  useEffect(() => {
    const url = new URLSearchParams(window.location.search);
    // Home page links use short names (type, beds, price); saved searches and shared links use the API names. Both work.
    const init = { ...BLANK, ...filtersFromParams(url), ...definedOnly(formFromQuery(parseSearchQuery(url))) };
    setForm(init);
    setApplied(init);
    if (url.get("view") === "map") setView("map");
    if (url.get("saved") === "1") setFromSaved(true);
    const s = parseSearchQuery(url).sort;
    if (s !== "newest") setSort(s);
    setReady(true);
  }, []);

  // The filters, sort and view go in the address bar, so a shared or reloaded link opens the same search.
  useEffect(() => {
    if (!ready) return;
    const u = new URL(window.location.href);
    u.search = queryString(applied);
    if (sort !== "newest") u.searchParams.set("sort", sort);
    if (view === "map") u.searchParams.set("view", "map");
    window.history.replaceState(null, "", u);
  }, [ready, applied, sort, view]);
  const pick = (v: View) => setView(v);

  // Elena sets filters, or removes the ones that leave no results.
  const applyParams = (params: Record<string, string>) => {
    const f = formFromQuery(parseSearchQuery(new URLSearchParams(params)));
    setForm(f); setApplied(f); setPage(1);
    if (sort === "distance" && !f.lat) setSort("newest");
  };
  // The buyer advisor adds what the buyer says on top of the filters already applied.
  const advise = (params: Record<string, string>) => {
    const keep = filterParams(applied);
    for (const k of ADVISOR_KEYS) keep.delete(k);
    applyParams({ ...Object.fromEntries(keep), ...params });
  };
  const clearParams = (names: string[]) => {
    const p = filterParams(applied);
    for (const n of names) p.delete(n);
    applyParams(Object.fromEntries(p));
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

  // Investment projects that match the search words (only while the investor module is live; otherwise none come back).
  useEffect(() => {
    setProjects([]);
    if (!ready || !applied.q.trim()) return;
    fetch(`/api/search?q=${encodeURIComponent(applied.q.trim())}`).then(r => (r.ok ? r.json() : null))
      .then(d => setProjects(d?.projects?.items ?? [])).catch(() => setProjects([]));
  }, [ready, applied.q]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const appliedQuery = queryString(applied);
  const nearApplied = applied.lat !== "" && applied.radiusKm !== "";
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
      <ElenaSearch query={appliedQuery} total={rows === null ? null : total} onApply={applyParams} onClear={clearParams} />
      {ready && <BuyerAdvisor query={appliedQuery} total={rows === null ? null : total} startOpen={false} onApply={advise} />}
      <form id="listing-search" className="search-form" aria-label="Search listings" onSubmit={e => { e.preventDefault(); setPage(1); setApplied(form); }}>
        <input className="wide search-words" type="search" aria-label="Search by street, suburb or feature" placeholder="Search by street, suburb or feature, e.g. saltwater pool" maxLength={100} value={form.q} onChange={set("q")} />
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
        <MoreFilters form={form} setForm={setForm} />
        <div className="actions">
          <button type="submit">Search</button>
          <button type="button" className="secondary" onClick={() => { setForm(BLANK); setApplied(BLANK); setFromSaved(false); setPage(1); if (sort === "distance") setSort("newest"); }}>Clear</button>
        </div>
      </form>
      {describeFilters(applied).length > 0 && (
        <div className="active-filters" role="status" aria-label="Applied filters">
          <span className="muted">{fromSaved ? "Showing your saved search:" : "Filtered by:"}</span>
          <ul className="chips">{describeFilters(applied).map(t => <li key={t} className="chip">{t}</li>)}</ul>
          <a href="/buyer/saved-searches">Saved searches</a>
        </div>
      )}
      <div className="result-bar" id="listing-results">
        <div className="view-toggle" role="group" aria-label="Show results as">
          <button type="button" className="secondary" aria-pressed={view === "list"} onClick={() => pick("list")}><span className="vt-icon vt-list" aria-hidden="true" />List</button>
          <button type="button" className="secondary" aria-pressed={view === "map"} onClick={() => pick("map")}><span className="vt-icon vt-map" aria-hidden="true" />Map</button>
        </div>
        {view === "list" && (
          <div className="result-bar-end">
            <span className="muted" role="status">{rows === null && !error ? "Loading..." : `${total} ${total === 1 ? "listing" : "listings"}`}</span>
            <SaveSearch query={appliedQuery} />
            <select aria-label="Sort" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}>
              <option value="newest">Newest</option>
              <option value="price_asc">Price: low to high</option>
              <option value="price_desc">Price: high to low</option>
              <option value="bedrooms_desc">Most bedrooms</option>
              {nearApplied && <option value="distance">Closest first</option>}
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
                  {r.distanceKm !== undefined && <li className="chip">{r.distanceKm} km away</li>}
                  {(r.amenities ?? []).filter(isAmenity).slice(0, 3).map(a => <li key={a} className="chip">{AMENITY_LABELS[a]}</li>)}
                </ul>
                <p className="lcard-meta">{r.suburb ? `${r.suburb} ${r.postcode ?? ""} · ` : ""}{r.jurisdiction} · {r.propertyType.charAt(0).toUpperCase() + r.propertyType.slice(1)}</p>
                <CompareToggle id={r.id} title={r.title} />
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
      {projects.length > 0 && (
        <section className="project-hits" aria-label="Investment projects that match">
          <h2>Investment projects matching &ldquo;{applied.q}&rdquo;</h2>
          <ul>{projects.map(p => <li key={p.id}><a href={`/investments/${p.id}`}>{p.title}</a> <span className="muted">{p.location}</span></li>)}</ul>
        </section>
      )}
      <CompareTray />
    </main>
  );
}
