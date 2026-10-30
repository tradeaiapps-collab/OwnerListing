/**
 * Which map tiles the site draws. NEXT_PUBLIC_MAP_PROVIDER=openstreetmap (the default) uses OpenStreetMap's own tiles: free, no key,
 * attribution required, light use only under their tile policy. "custom" uses NEXT_PUBLIC_MAP_TILE_URL and NEXT_PUBLIC_MAP_ATTRIBUTION
 * (a paid or self-hosted provider). A tile URL set without a provider is read as custom, as before. Mirrored in src/config/provider-check.mjs.
 */
export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors";

export type MapProvider = "openstreetmap" | "custom";
export interface TileSource { provider: MapProvider; url: string; attribution: string; maxZoom: number }

export function mapTileSource(provider?: string, url?: string, attribution?: string): TileSource {
  const p = provider?.trim().toLowerCase();
  const custom = url?.trim();
  if (custom && (p === "custom" || !p)) return { provider: "custom", url: custom, attribution: attribution?.trim() || OSM_ATTRIBUTION, maxZoom: 19 };
  return { provider: "openstreetmap", url: OSM_TILE_URL, attribution: OSM_ATTRIBUTION, maxZoom: 19 };
}

/** The spot on openstreetmap.org, for "Open in OpenStreetMap" (directions, wider area). */
export function osmLink(lat: number, lng: number, zoom = 17): string {
  const a = lat.toFixed(6), o = lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${a}&mlon=${o}#map=${zoom}/${a}/${o}`;
}
