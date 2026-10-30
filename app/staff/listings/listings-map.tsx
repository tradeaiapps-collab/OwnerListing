"use client";
import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { labelFor } from "../../../src/domain/admin-dashboard";
import { AUSTRALIA, createMap, loadLeaflet, whenVisible } from "../../listings/leaflet";
import "../../styles/map.css";

export interface MapRow { id: string; title: string; suburb: string | null; jurisdiction: string; status: string; latitude: number | null; longitude: number | null }

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const tone = (s: string) => (s === "published" ? "is-good" : s === "suspended" ? "is-bad" : s === "pending_review" ? "is-warn" : "is-muted");

/** The moderation results on a map, one pin per listing with a location, coloured by status. Same rows as the table. */
export function StaffListingsMap({ rows }: { rows: MapRow[] }) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const layer = useRef<Leaflet.LayerGroup | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const located = rows.filter(r => r.latitude !== null && r.longitude !== null);

  useEffect(() => {
    let cancelled = false;
    const stop = el.current ? whenVisible(el.current, () => void loadLeaflet().then(lib => {
      if (cancelled || !el.current || map.current) return;
      L.current = lib;
      const m = createMap(lib, el.current);
      m.fitBounds(AUSTRALIA);
      layer.current = lib.layerGroup().addTo(m);
      map.current = m;
      setReady(true);
    }).catch(() => setError("The map could not be loaded. Use the table instead."))) : () => undefined;
    return () => { cancelled = true; stop(); map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const lib = L.current, m = map.current, g = layer.current;
    if (!ready || !lib || !m || !g) return;
    g.clearLayers();
    for (const r of located) {
      const pin = lib.marker([r.latitude!, r.longitude!], {
        icon: lib.divIcon({ className: `loc-pin ${tone(r.status)}`, html: "<span></span>", iconSize: undefined, iconAnchor: [0, 0], popupAnchor: [0, -34] }),
        title: `${r.title}, ${labelFor(r.status)}`, alt: r.title, keyboard: true, riseOnHover: true
      });
      const view = r.status === "published" ? `<br><a href="/listings/${encodeURIComponent(r.id)}" target="_blank" rel="noreferrer">View listing</a>` : "";
      pin.bindPopup(`<strong>${esc(r.title)}</strong><br>${esc(r.suburb ?? "No suburb")}, ${esc(r.jurisdiction)}<br>${esc(labelFor(r.status))}${view}`, { className: "map-popup", autoPanPaddingTopLeft: [16, 96], autoPanPaddingBottomRight: [16, 16] });
      g.addLayer(pin);
    }
    if (located.length > 0) m.fitBounds(lib.latLngBounds(located.map(r => [r.latitude!, r.longitude!])), { padding: [48, 48], maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ready]);

  const status = error || (!ready ? "Loading the map..." : located.length === 0
    ? "None of these listings has a map location yet."
    : `${located.length} of ${rows.length} ${rows.length === 1 ? "listing" : "listings"} shown on the map`);

  return (
    <div className="staff-map">
      <div className="map-frame">
        <div ref={el} className="map-canvas" role="region" aria-label="Map of the listings in the table. Use the arrow keys to pan and plus or minus to zoom." />
        <p className="map-status" role="status">{status}</p>
      </div>
      <ul className="staff-map-key" aria-label="Pin colours">
        <li><span className="key-dot is-good" aria-hidden="true" />Published</li>
        <li><span className="key-dot is-warn" aria-hidden="true" />Pending review</li>
        <li><span className="key-dot is-bad" aria-hidden="true" />Suspended</li>
        <li><span className="key-dot is-muted" aria-hidden="true" />Draft, withdrawn or archived</li>
      </ul>
    </div>
  );
}
