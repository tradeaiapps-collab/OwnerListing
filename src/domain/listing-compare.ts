import { AMENITIES, AMENITY_LABELS, formatPrice } from "./listing-details";
import type { PublicListing } from "./listing-service";

export const MIN_COMPARE = 2;
export const MAX_COMPARE = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "id,id,id" to 2 to 4 distinct ids in the order given. Undefined for anything else, so a bad link shows a clear message. */
export function parseCompareIds(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const ids = [...new Set(v.split(",").map(x => x.trim().toLowerCase()))];
  if (ids.length < MIN_COMPARE || ids.length > MAX_COMPARE || !ids.every(i => UUID_RE.test(i))) return undefined;
  return ids;
}

export interface CompareRow {
  key: string;
  label: string;
  /** One display value per listing, same order as `listings`. "Not stated" when the owner left it blank. */
  values: string[];
  /** Indexes of the listings that are best on this row (only when they differ). */
  best: number[];
}
export interface Comparison {
  rows: CompareRow[];
  /** Short factual points, e.g. "Lowest price: ...". */
  highlights: string[];
  /** Plain-text summary built from the numbers only. Safe to show without AI. */
  summary: string;
  /** False when a sale and a rent are mixed: prices are then not ranked, because a price and a weekly rent are not comparable. */
  comparablePrices: boolean;
}

const NOT_STATED = "Not stated";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const name = (l: PublicListing) => l.title;

/** Indexes with the best value, or [] when every listing is equal or fewer than two have a value. */
function bestIndexes(vals: Array<number | undefined>, better: "low" | "high"): number[] {
  const known = vals.flatMap((v, i) => (v === undefined ? [] : [{ v, i }]));
  if (known.length < 2) return [];
  const target = better === "low" ? Math.min(...known.map(k => k.v)) : Math.max(...known.map(k => k.v));
  const winners = known.filter(k => k.v === target).map(k => k.i);
  return winners.length === known.length ? [] : winners;
}

/** Side-by-side facts and plain highlights for 2 to 4 published listings. Pure; the AI only rewords this, it never adds numbers. */
export function compareProperties(ls: readonly PublicListing[]): Comparison {
  const sameTx = ls.every(l => l.transactionType === ls[0]!.transactionType);
  const tx = ls[0]!.transactionType;
  const num = (label: string, key: string, get: (l: PublicListing) => number | undefined, better: "low" | "high" | undefined, fmt: (n: number) => string = String): CompareRow => {
    const vals = ls.map(get);
    return { key, label, values: vals.map(v => (v === undefined ? NOT_STATED : fmt(v))), best: better ? bestIndexes(vals, better) : [] };
  };
  const perBed = (l: PublicListing) => (l.priceCents !== undefined && l.bedrooms !== undefined && l.bedrooms > 0 ? Math.round(l.priceCents / l.bedrooms) : undefined);

  const rows: CompareRow[] = [
    num(sameTx && tx === "rent" ? "Rent per week" : "Price", "price", l => l.priceCents, sameTx ? "low" : undefined,
      n => formatPrice(n, "sale")),
    { key: "transaction", label: "For", values: ls.map(l => cap(l.transactionType === "rent" ? "rent" : "sale")), best: [] },
    { key: "type", label: "Type", values: ls.map(l => cap(l.propertyType)), best: [] },
    num("Bedrooms", "bedrooms", l => l.bedrooms, "high"),
    num("Bathrooms", "bathrooms", l => l.bathrooms, "high"),
    num("Parking", "parking", l => l.parking, "high"),
    num(tx === "rent" ? "Rent per bedroom" : "Price per bedroom", "perBedroom", perBed, sameTx ? "low" : undefined, n => formatPrice(n, "sale")),
    { key: "location", label: "Suburb", values: ls.map(l => l.suburb ? `${l.suburb}${l.postcode ? ` ${l.postcode}` : ""}, ${l.jurisdiction}` : l.jurisdiction), best: [] }
  ];
  if (!sameTx) {
    // Mixed sale and rent: show each price with its unit instead of ranking them.
    rows[0]!.values = ls.map(l => (l.priceCents === undefined ? NOT_STATED : formatPrice(l.priceCents, l.transactionType)));
    rows[0]!.label = "Price";
    rows[6]!.values = ls.map(l => { const v = perBed(l); return v === undefined ? NOT_STATED : formatPrice(v, l.transactionType); });
  } else if (tx === "rent") {
    rows[0]!.values = ls.map(l => (l.priceCents === undefined ? NOT_STATED : formatPrice(l.priceCents, "rent")));
    rows[6]!.values = ls.map(l => { const v = perBed(l); return v === undefined ? NOT_STATED : `${formatPrice(v, "sale")} per week`; });
  }
  for (const a of AMENITIES) {
    if (!ls.some(l => l.amenities?.includes(a))) continue;
    const has = ls.map(l => l.amenities?.includes(a) === true);
    rows.push({ key: `amenity:${a}`, label: AMENITY_LABELS[a], values: has.map(h => (h ? "Yes" : "No")), best: has.every(Boolean) ? [] : has.flatMap((h, i) => (h ? [i] : [])) });
  }

  const highlights: string[] = [];
  const price = rows[0]!;
  if (sameTx && price.best.length === 1) {
    const vals = ls.map(l => l.priceCents).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    const gap = vals[1]! - vals[0]!;
    highlights.push(`Lowest ${tx === "rent" ? "rent" : "price"}: ${name(ls[price.best[0]!]!)} at ${price.values[price.best[0]!]!}, ${formatPrice(gap, "sale")}${tx === "rent" ? " per week" : ""} below the next.`);
  }
  for (const key of ["bedrooms", "bathrooms", "parking"] as const) {
    const r = rows.find(x => x.key === key)!;
    if (r.best.length > 0 && r.best.length < ls.length) highlights.push(`Most ${key}: ${r.best.map(i => `${name(ls[i]!)} (${r.values[i]})`).join(", ")}.`);
  }
  const pb = rows.find(x => x.key === "perBedroom")!;
  if (sameTx && pb.best.length === 1) highlights.push(`Lowest ${tx === "rent" ? "rent" : "price"} per bedroom: ${name(ls[pb.best[0]!]!)} at ${pb.values[pb.best[0]!]!}.`);
  // Features only one listing has, grouped per listing so the summary stays short.
  const unique = new Map<number, string[]>();
  for (const a of AMENITIES) {
    const w = ls.map((l, i) => (l.amenities?.includes(a) ? i : -1)).filter(i => i >= 0);
    if (w.length === 1 && ls.length > 1) unique.set(w[0]!, [...(unique.get(w[0]!) ?? []), AMENITY_LABELS[a].toLowerCase()]);
  }
  for (const [i, names] of unique) highlights.push(`Only ${name(ls[i]!)} lists ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}.`);
  if (!sameTx) highlights.push("These include both a sale and a rental, so prices are shown but not ranked.");
  const missing = rows[0]!.values.filter(v => v === NOT_STATED).length;
  if (missing > 0) highlights.push(`${missing} of ${ls.length} listings do not state a price.`);

  const summary = highlights.length > 0
    ? `Comparing ${ls.length} properties: ${highlights.join(" ")}`
    : `Comparing ${ls.length} properties: they are level on every figure the owners have stated.`;
  return { rows, highlights, summary, comparablePrices: sameTx };
}
