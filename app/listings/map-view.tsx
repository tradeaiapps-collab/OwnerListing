"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { formatPrice } from "../../src/domain/listing-details";
import { clusterPoints, shortPrice } from "../../src/domain/map-cluster";
import type { CardPhoto } from "../../src/domain/listing-photos";
import { CardMedia } from "./card-media";
import { AUSTRALIA, createMap, loadLeaflet, whenVisible } from "./leaflet";
import { filterParams, type FilterForm } from "./url-params";
import "../styles/map.css";

type Pin = {
  id: string; title: string; address: string; latitude: number; longitude: number; transactionType: "sale" | "rent";
  propertyType: string; suburb?: string; postcode?: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number;
} & CardPhoto;

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pinLabel = (p: Pin) => (p.priceCents !== undefined ? shortPrice(p.priceCents, p.transactionType) : p.transactionType === "sale" ? "For sale" : "For rent");
const bboxOf = (b: Leaflet.LatLngBounds) => [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map(n => n.toFixed(5)).join(",");

function Features({ p }: { p: Pin }) {
  if (p.bedrooms === undefined && p.bathrooms === undefined && p.parking === undefined) return null;
  return (
    <ul className="chips" aria-label="Features">
      {p.bedrooms !== undefined && <li className="chip chip-bed">{p.bedrooms} bed</li>}
      {p.bathrooms !== undefined && <li className="chip chip-bath">{p.bathrooms} bath</li>}
      {p.parking !== undefined && <li className="chip chip-car">{p.parking} car</li>}
    </ul>
  );
}

/**
 * Search results on a map. Pins that would overlap are grouped into numbered clusters (src/domain/map-cluster.ts);
 * clicking a cluster zooms to it, clicking a price pin opens its card. The visible area is sent as bbox, so only
 * the listings in view are loaded. Listings without a map location are not shown here (they stay in the list view).
 */
export function MapView({ filters }: { filters: FilterForm }) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const fitted = useRef(false);
  const seq = useRef(0);
  const [pins, setPins] = useState<Pin[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(500);
  const [zoom, setZoom] = useState(4);
  const [bbox, setBbox] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [mapReady, setMapReady] = useState(false);

  const base = useMemo(() => filterParams(filters).toString(), [filters]);

  // Create the map once, when it scrolls into view.
  useEffect(() => {
    let cancelled = false;
    const stop = el.current ? whenVisible(el.current, () => void loadLeaflet().then(lib => {
      if (cancelled || !el.current || map.current) return;
      L.current = lib;
      const m = createMap(lib, el.current);
      m.fitBounds(AUSTRALIA);
      layer.current = lib.layerGroup().addTo(m);
      m.on("moveend", () => { setZoom(m.getZoom()); if (fitted.current) setBbox(bboxOf(m.getBounds())); });
      map.current = m;
      setZoom(m.getZoom());
      setMapReady(true);
    }).catch(() => setError("The map could not be loaded. Use the list view instead."))) : () => undefined;
    return () => { cancelled = true; stop(); map.current?.remove(); map.current = null; };
  }, []);

  // New filters: load every matching pin and fit the map to them.
  useEffect(() => {
    if (!mapReady) return;
    fitted.current = false;
    setBbox(null);
    setSelected(null);
  }, [base, mapReady]);

  // Load pins: the whole result first (to fit the map), then whatever is in view after the person pans or zooms.
  useEffect(() => {
    if (!mapReady) return;
    const id = ++seq.current;
    const q = new URLSearchParams(base);
    if (bbox) q.set("bbox", bbox);
    setError("");
    const t = window.setTimeout(() => {
      fetch(`/api/listings/map?${q}`)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { pins: Pin[]; total: number; limit: number }) => {
          if (id !== seq.current) return;
          setPins(d.pins); setTotal(d.total); setLimit(d.limit);
          if (!fitted.current && map.current && L.current) {
            if (d.pins.length > 0) map.current.fitBounds(L.current.latLngBounds(d.pins.map(p => [p.latitude, p.longitude])), { padding: [48, 48], maxZoom: 14 });
            fitted.current = true;
            setBbox(bboxOf(map.current.getBounds()));
          }
        })
        .catch(() => { if (id === seq.current) setError("Could not load the map results. Try again."); });
    }, bbox ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [base, bbox, mapReady]);

  // Draw pins and clusters for the current zoom.
  useEffect(() => {
    const lib = L.current, m = map.current, g = layer.current;
    if (!lib || !m || !g || !pins) return;
    g.clearLayers();
    for (const item of clusterPoints(pins, zoom)) {
      if (item.kind === "cluster") {
        const size = item.count < 10 ? 40 : item.count < 100 ? 48 : 56;
        const marker = lib.marker([item.latitude, item.longitude], {
          icon: lib.divIcon({ className: "map-cluster", html: `<span>${item.count}</span>`, iconSize: [size, size] }),
          title: `${item.count} listings here. Zoom in`, alt: `${item.count} listings`, keyboard: true, riseOnHover: true
        });
        marker.on("click", () => {
          const b = item.bounds;
          if (b.south === b.north && b.west === b.east) m.setView([b.south, b.west], Math.min(m.getZoom() + 3, 18));
          else m.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [56, 56], maxZoom: 18 });
        });
        g.addLayer(marker);
      } else {
        const p = item.point;
        const active = p.id === selected || p.id === hover;
        const marker = lib.marker([p.latitude, p.longitude], {
          icon: lib.divIcon({
            className: `map-pin${p.transactionType === "rent" ? " is-rent" : ""}${active ? " is-active" : ""}`,
            html: `<span>${esc(pinLabel(p))}</span>`, iconSize: undefined, iconAnchor: [0, 0]
          }),
          title: `${p.title}, ${p.priceCents !== undefined ? formatPrice(p.priceCents, p.transactionType) : cap(p.transactionType)}`,
          alt: p.title, keyboard: true, riseOnHover: true, zIndexOffset: active ? 1000 : 0
        });
        marker.on("click", () => {
          setSelected(p.id);
          // Bring its row into view only where the side list scrolls on its own (wide screens); never scroll the page away from the map.
          const item = listRef.current?.querySelector<HTMLElement>(`[data-id="${p.id}"]`);
          const side = listRef.current?.parentElement;
          if (item && side && side.scrollHeight > side.clientHeight) side.scrollTo({ top: item.offsetTop - 8, behavior: "smooth" });
        });
        g.addLayer(marker);
      }
    }
  }, [pins, zoom, selected, hover]);

  const sel = pins?.find(p => p.id === selected) ?? null;
  const shown = pins?.length ?? 0;
  const status = pins === null ? "Loading the map..." : total === 0
    ? "No listings with a map location match. Try fewer filters or zoom out."
    : total > shown ? `Showing ${shown} of ${total} listings in this area. Zoom in or add filters to see them all.`
      : `${total} ${total === 1 ? "listing" : "listings"} in this area`;

  return (
    <div className="map-layout">
      <div className="map-frame">
        <div ref={el} className="map-canvas" role="region" aria-label="Map of listings. Use the arrow keys to pan and plus or minus to zoom." />
        <p className="map-status" role="status">{error || status}</p>
        {sel && (
          <article className="map-card lcard" aria-label={`Selected: ${sel.title}`}>
            <CardMedia photo={sel} transactionType={sel.transactionType} />
            <div className="lcard-body">
              {sel.priceCents !== undefined && <p className="lcard-price">{formatPrice(sel.priceCents, sel.transactionType)}</p>}
              <h2 className="lcard-title"><a href={`/listings/${sel.id}`}>{sel.title}</a></h2>
              <p className="lcard-addr">{sel.address}</p>
              <Features p={sel} />
            </div>
            <button type="button" className="map-card-close" aria-label="Close" onClick={() => setSelected(null)}>×</button>
          </article>
        )}
      </div>
      <aside className="map-side" aria-label="Listings in this area">
        <h2 className="map-side-head">{pins === null ? "Loading..." : `${total} in this area`}</h2>
        {pins && pins.length === 0 && <p className="empty">Nothing here yet. Zoom out or change the filters.</p>}
        <ol ref={listRef} className="map-list">
          {pins?.map(p => (
            <li key={p.id} data-id={p.id} className={`map-item${p.id === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(h => (h === p.id ? null : h))}
              onFocus={() => setHover(p.id)} onBlur={() => setHover(h => (h === p.id ? null : h))}>
              <div className="map-item-thumb"><CardMedia photo={p} transactionType={p.transactionType} /></div>
              <div className="map-item-body">
                {p.priceCents !== undefined && <p className="map-item-price">{formatPrice(p.priceCents, p.transactionType)}</p>}
                <h3 className="map-item-title"><a href={`/listings/${p.id}`}>{p.title}</a></h3>
                <p className="map-item-meta">{p.suburb ? `${p.suburb} ${p.postcode ?? ""} · ` : ""}{cap(p.propertyType)}</p>
                <Features p={p} />
                <button type="button" className="linklike map-item-show" onClick={() => {
                  setSelected(p.id);
                  map.current?.setView([p.latitude, p.longitude], Math.max(map.current.getZoom(), 15));
                }}>Show on map</button>
              </div>
            </li>
          ))}
        </ol>
        {total > limit && <p className="muted">Only the newest {limit} are listed. Zoom in to narrow the area.</p>}
      </aside>
    </div>
  );
}
