import type * as Leaflet from "leaflet";

/**
 * Map tiles. OpenStreetMap's public tiles are fine for local testing only (their policy forbids heavy use);
 * production sets NEXT_PUBLIC_MAP_TILE_URL and NEXT_PUBLIC_MAP_ATTRIBUTION to a paid or self-hosted provider.
 */
const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors";

/** Australia, for a map with nothing to fit yet. */
export const AUSTRALIA: [[number, number], [number, number]] = [[-43.7, 112.9], [-10.5, 153.7]];

/** Leaflet touches `window` when imported, so it is loaded in the browser only. */
export async function loadLeaflet(): Promise<typeof Leaflet> {
  const mod = await import("leaflet");
  return (mod as unknown as { default?: typeof Leaflet }).default ?? mod;
}

/** A map in `el` with the site's tiles, keyboard and zoom controls, and no tracking. */
export function createMap(L: typeof Leaflet, el: HTMLElement, opts: Leaflet.MapOptions = {}): Leaflet.Map {
  const map = L.map(el, { zoomControl: true, scrollWheelZoom: true, keyboard: true, worldCopyJump: false, minZoom: 3, maxZoom: 19, ...opts });
  map.attributionControl.setPrefix(false);
  L.tileLayer(TILE_URL, { attribution: ATTRIBUTION, maxZoom: 19, crossOrigin: true, className: "map-tiles" }).addTo(map);
  return map;
}
