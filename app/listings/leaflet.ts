import type * as Leaflet from "leaflet";
import { mapTileSource } from "../../src/domain/map-tiles";

/**
 * Map tiles: OpenStreetMap by default (no key). NEXT_PUBLIC_MAP_PROVIDER=custom with NEXT_PUBLIC_MAP_TILE_URL and
 * NEXT_PUBLIC_MAP_ATTRIBUTION switches to a paid or self-hosted provider. Read at build time (NEXT_PUBLIC_*).
 */
const TILES = mapTileSource(process.env.NEXT_PUBLIC_MAP_PROVIDER, process.env.NEXT_PUBLIC_MAP_TILE_URL, process.env.NEXT_PUBLIC_MAP_ATTRIBUTION);

/** Australia, for a map with nothing to fit yet. */
export const AUSTRALIA: [[number, number], [number, number]] = [[-43.7, 112.9], [-10.5, 153.7]];

/** Leaflet touches `window` when imported, so it is loaded in the browser only. */
export async function loadLeaflet(): Promise<typeof Leaflet> {
  const mod = await import("leaflet");
  return (mod as unknown as { default?: typeof Leaflet }).default ?? mod;
}

/**
 * Runs `cb` once `el` is on screen (or near it), so Leaflet and its tiles load only for a map someone will see.
 * Returns a cancel function. Browsers without IntersectionObserver load at once.
 */
export function whenVisible(el: Element, cb: () => void, rootMargin = "200px"): () => void {
  if (typeof IntersectionObserver === "undefined") { cb(); return () => undefined; }
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) { io.disconnect(); cb(); }
  }, { rootMargin });
  io.observe(el);
  return () => io.disconnect();
}

/** A map in `el` with the site's tiles, keyboard and zoom controls, and no tracking. */
export function createMap(L: typeof Leaflet, el: HTMLElement, opts: Leaflet.MapOptions = {}): Leaflet.Map {
  const map = L.map(el, { zoomControl: true, scrollWheelZoom: true, keyboard: true, worldCopyJump: false, minZoom: 3, maxZoom: TILES.maxZoom, ...opts });
  map.attributionControl.setPrefix(false);
  L.tileLayer(TILES.url, { attribution: TILES.attribution, maxZoom: TILES.maxZoom, crossOrigin: true, className: "map-tiles" }).addTo(map);
  return map;
}
