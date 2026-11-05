"use client";
import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import { osmLink } from "../../src/domain/map-tiles";
import { createMap, loadLeaflet, whenVisible } from "./leaflet";
import "../styles/map.css";

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/**
 * Where the home is, on the listing page: one pin with a popup naming the address. Leaflet loads only when the map scrolls into view.
 * On touch screens one finger scrolls the page, not the map; the zoom buttons and the OpenStreetMap link still work.
 */
export function LocationMap({ latitude, longitude, title, address, transactionType }: {
  latitude: number; longitude: number; title: string; address: string; transactionType: "sale" | "rent";
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<Leaflet.Map | null>(null);
  const [state, setState] = useState<"waiting" | "ready" | "error">("waiting");

  useEffect(() => {
    let cancelled = false;
    const stop = el.current ? whenVisible(el.current, () => void loadLeaflet().then(lib => {
      if (cancelled || !el.current || map.current) return;
      const m = createMap(lib, el.current, { scrollWheelZoom: false, dragging: !lib.Browser.mobile, center: [latitude, longitude], zoom: 16 });
      const pin = lib.marker([latitude, longitude], {
        icon: lib.divIcon({ className: `loc-pin${transactionType === "rent" ? " is-rent" : ""}`, html: "<span></span>", iconSize: undefined, iconAnchor: [0, 0], popupAnchor: [0, -34] }),
        title: address, alt: `Location of ${title}`, keyboard: true
      }).addTo(m);
      pin.bindPopup(`<strong>${esc(title)}</strong><br>${esc(address)}`, { className: "map-popup", closeButton: true, autoPanPaddingTopLeft: [16, 96], autoPanPaddingBottomRight: [16, 16] });
      map.current = m;
      setState("ready");
    }).catch(() => { if (!cancelled) setState("error"); })) : () => undefined;
    return () => { cancelled = true; stop(); map.current?.remove(); map.current = null; };
  }, [latitude, longitude, title, address, transactionType]);

  return (
    <section className="pd-section loc-map" aria-labelledby="pd-location">
      <h2 id="pd-location">Location</h2>
      <p className="loc-map-addr">{address}</p>
      <div className="map-frame">
        <div ref={el} className="map-canvas" role="region" aria-label={`Map showing ${address}. Use the arrow keys to pan and plus or minus to zoom.`} />
        {state !== "ready" && <p className="map-status" role="status">{state === "error" ? "The map could not be loaded." : "Loading the map..."}</p>}
      </div>
      <p className="loc-map-link"><a href={osmLink(latitude, longitude)} target="_blank" rel="noopener noreferrer">Open in OpenStreetMap</a></p>
    </section>
  );
}
