"use client";
import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { AU_BOUNDS } from "../../src/domain/listing-details";
import { AUSTRALIA, createMap, loadLeaflet } from "./leaflet";
import { JSON_HEADERS } from "./ui";
import "../styles/map.css";

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const inAustralia = (lat: number, lng: number) => lat >= AU_BOUNDS.south && lat <= AU_BOUNDS.north && lng >= AU_BOUNDS.west && lng <= AU_BOUNDS.east;

/**
 * The owner places the listing's pin for the search map: click the map (or drag the pin), then save.
 * Saved straight to the draft with PATCH; a listing without a pin is still searchable, just not on the map.
 */
export function LocationPicker({ listingId, latitude, longitude, onSaved }: {
  listingId: string; latitude?: number | undefined; longitude?: number | undefined; onSaved?: (lat: number | null, lng: number | null) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const L = useRef<typeof Leaflet | null>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const marker = useRef<Leaflet.Marker | null>(null);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(latitude !== undefined && longitude !== undefined ? { lat: latitude, lng: longitude } : null);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(lib => {
      if (cancelled || !el.current || map.current) return;
      L.current = lib;
      const m = createMap(lib, el.current, { scrollWheelZoom: false });
      if (pos) m.setView([pos.lat, pos.lng], 16); else m.fitBounds(AUSTRALIA);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => place(e.latlng.lat, e.latlng.lng));
      map.current = m;
      if (pos) drawPin(pos.lat, pos.lng);
    }).catch(() => setMessage("The map could not be loaded."));
    return () => { cancelled = true; map.current?.remove(); map.current = null; marker.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function drawPin(lat: number, lng: number) {
    const lib = L.current, m = map.current;
    if (!lib || !m) return;
    if (marker.current) { marker.current.setLatLng([lat, lng]); return; }
    const mk = lib.marker([lat, lng], { draggable: true, keyboard: true, title: "Listing location (drag to move)", alt: "Listing location",
      icon: lib.divIcon({ className: "loc-dot", html: "<span></span>", iconSize: undefined, iconAnchor: [0, 0] }) });
    mk.on("dragend", () => { const p = mk.getLatLng(); place(p.lat, p.lng); });
    mk.addTo(m);
    marker.current = mk;
  }

  function place(lat: number, lng: number) {
    if (!inAustralia(lat, lng)) { setMessage("Place the pin in Australia."); return; }
    const next = { lat: round6(lat), lng: round6(lng) };
    setPos(next); setDirty(true); setState("idle"); setMessage("");
    drawPin(next.lat, next.lng);
  }

  async function save(clear = false) {
    setState("saving"); setMessage("");
    const body = clear || !pos ? { latitude: null, longitude: null } : { latitude: pos.lat, longitude: pos.lng };
    try {
      const res = await fetch(`/api/listings/${listingId}`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setState("error"); setMessage(d.error ?? "Could not save the location."); return; }
      if (clear) { setPos(null); marker.current?.remove(); marker.current = null; }
      setDirty(false); setState("saved");
      onSaved?.(body.latitude, body.longitude);
    } catch { setState("error"); setMessage("Could not save the location."); }
  }

  return (
    <section className="panel loc-picker" aria-labelledby="loc-h">
      <h3 id="loc-h">Map location</h3>
      <p className="muted">Click the map where the property is, or drag the pin. Buyers see this pin on the search map. Zoom in close so it sits on the right building.</p>
      <div ref={el} className="map-canvas" role="region" aria-label="Map for placing the listing. Click to place the pin." />
      <p className="muted" aria-live="polite">{pos ? `Pin at ${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}${dirty ? " (not saved yet)" : ""}` : "No pin yet. The listing will not show on the search map until it has one."}</p>
      <div className="form-bar">
        <button type="button" disabled={!pos || !dirty || state === "saving"} onClick={() => save()}>{state === "saving" ? "Saving..." : "Save location"}</button>
        {(latitude !== undefined || (pos && !dirty)) && <button type="button" className="secondary" disabled={state === "saving"} onClick={() => save(true)}>Remove pin</button>}
        {state === "saved" && <span role="status">Location saved.</span>}
      </div>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
