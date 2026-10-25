import { parseSearchQuery } from "../domain/listing-search";
import { searchPublished, toPublicListing } from "../domain/listing-service";
import { getDb, getDeps } from "./context";

/** A card on the home page. coverUrl stays undefined until listing cover photos exist; the card then shows the photo instead of the placeholder. */
export interface HomeCard {
  id: string; title: string; suburb?: string; postcode?: string; jurisdiction: string; transactionType: "sale" | "rent";
  propertyType: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number; coverUrl?: string;
}

/** Resolves to `fallback` on any error or after `ms`, so a slow or missing database never breaks the home page. */
async function within<T>(p: () => Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = p();
    run.catch(() => undefined);
    return await Promise.race([run, new Promise<T>(res => { timer = setTimeout(() => res(fallback), ms); })]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** Latest published listings (public fields only). */
export const loadLatest = (n = 8): Promise<HomeCard[]> => within(async () => {
  const page = await searchPublished(getDeps(), parseSearchQuery(new URLSearchParams({ pageSize: String(n) })));
  return page.items.map(toPublicListing).map(l => ({
    id: l.id, title: l.title, jurisdiction: l.jurisdiction, transactionType: l.transactionType, propertyType: l.propertyType,
    ...(l.suburb ? { suburb: l.suburb } : {}), ...(l.postcode ? { postcode: l.postcode } : {}),
    ...(l.priceCents !== undefined ? { priceCents: l.priceCents } : {}), ...(l.bedrooms !== undefined ? { bedrooms: l.bedrooms } : {}),
    ...(l.bathrooms !== undefined ? { bathrooms: l.bathrooms } : {}), ...(l.parking !== undefined ? { parking: l.parking } : {})
  }));
}, 3000, []);

/** Suburbs that have a published listing, for the search box suggestions. Only public listing data. */
export const loadSuburbs = (): Promise<string[]> => within(async () => {
  const r = await getDb().query(
    `SELECT DISTINCT initcap(btrim(suburb)) AS s FROM property_listing WHERE status = 'published' AND suburb IS NOT NULL ORDER BY 1 LIMIT 300`
  );
  return r.rows.map(x => String(x["s"])).filter(s => s.length > 0 && s.length <= 80);
}, 2000, []);
