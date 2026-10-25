/** Groups map pins that would overlap on screen. Pure, so the same pins and zoom always give the same groups. */

export interface MapPoint { id: string; latitude: number; longitude: number }
export type MapGroup<T extends MapPoint> =
  | { kind: "pin"; point: T }
  | { kind: "cluster"; count: number; latitude: number; longitude: number; bounds: { south: number; west: number; north: number; east: number }; ids: string[] };

const TILE = 256;
/** Screen pixels per grid cell. Pins closer than about this on screen are drawn as one cluster. */
export const CLUSTER_CELL_PX = 64;
/** At this zoom and closer, pins are never clustered (street level: people want each home). */
export const MAX_CLUSTER_ZOOM = 16;

/** Web Mercator world pixel for a point at a zoom level (the projection map tiles use). */
export function project(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
  const scale = TILE * 2 ** zoom;
  const s = Math.sin((Math.max(-85, Math.min(85, latitude)) * Math.PI) / 180);
  return { x: ((longitude + 180) / 360) * scale, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale };
}

/**
 * Buckets points into a fixed screen grid at `zoom`. A bucket with one point stays a pin; two or more become a
 * cluster at their average position, with the box that holds them (the map zooms to that box when it is clicked).
 * Output order is stable: by bucket row, then column, so markers do not shuffle between renders.
 */
export function clusterPoints<T extends MapPoint>(points: readonly T[], zoom: number, cellPx = CLUSTER_CELL_PX): MapGroup<T>[] {
  if (zoom >= MAX_CLUSTER_ZOOM) return points.map(point => ({ kind: "pin", point }));
  const buckets = new Map<string, { row: number; col: number; items: T[] }>();
  for (const p of points) {
    const { x, y } = project(p.latitude, p.longitude, zoom);
    const col = Math.floor(x / cellPx), row = Math.floor(y / cellPx);
    const key = `${row}:${col}`;
    const b = buckets.get(key) ?? { row, col, items: [] };
    b.items.push(p);
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => a.row - b.row || a.col - b.col)
    .map(({ items }): MapGroup<T> => {
      if (items.length === 1) return { kind: "pin", point: items[0]! };
      const lats = items.map(i => i.latitude), lngs = items.map(i => i.longitude);
      return {
        kind: "cluster",
        count: items.length,
        latitude: lats.reduce((a, b) => a + b, 0) / items.length,
        longitude: lngs.reduce((a, b) => a + b, 0) / items.length,
        bounds: { south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) },
        ids: items.map(i => i.id).sort()
      };
    });
}

/** "$1.25m", "$825k", "$650/wk": short enough for a pin label. Full prices stay on the card. */
export function shortPrice(cents: number, tx: "sale" | "rent"): string {
  const d = cents / 100;
  if (tx === "rent") return `$${Math.round(d).toLocaleString("en-AU")}/wk`;
  if (d >= 1_000_000) return `$${(Math.round(d / 10_000) / 100).toString()}m`;
  if (d >= 1_000) return `$${Math.round(d / 1_000)}k`;
  return `$${Math.round(d)}`;
}
