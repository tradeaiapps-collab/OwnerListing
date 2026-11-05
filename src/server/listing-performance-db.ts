import { buildHeatmap, elenaAdvice, fillDays, marketComparison, median, totalsFor, windowStats, ageDays, PERFORMANCE_NOTE, type Advice, type CandidateListing, type DayPoint, type Heatmap, type MarketComparison, type Subject, type Unavailable, type WindowStats } from "../domain/listing-performance";
import type { Jurisdiction } from "../domain/jurisdiction";
import { JURISDICTION_TIME_ZONE } from "../domain/timezone";
import type { Queryable } from "./db";

/** Snapshots newer than this are served as they are; the market comparison and heatmap are rebuilt once a day. Parameterised SQL only. */
export const SNAPSHOT_FRESH_MS = 15 * 60_000;
export const MARKET_FRESH_MS = 24 * 3_600_000;
const HISTORY_DAYS = 90;
const CANDIDATE_LIMIT = 150;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const num = (v: unknown) => Number(v ?? 0);

export interface ListingFacts { id: string; title: string; status: string; propertyType: string; suburb?: string; postcode?: string; priceCents?: number; bedrooms?: number; createdAt: string; jurisdiction: Jurisdiction }

/** One listing's facts, or undefined. The caller has already proved who owns it. */
export async function loadListingFacts(db: Queryable, id: string): Promise<ListingFacts | undefined> {
  const x = (await db.query(
    "SELECT id, title, status, property_type, suburb, postcode, price_cents, bedrooms, created_at, jurisdiction FROM property_listing WHERE id = $1::uuid AND deleted_at IS NULL AND transaction_type = 'sale'", [id])).rows[0];
  if (!x) return undefined;
  return {
    id: String(x["id"]), title: String(x["title"]), status: String(x["status"]), propertyType: String(x["property_type"]),
    ...(x["suburb"] ? { suburb: String(x["suburb"]) } : {}), ...(x["postcode"] ? { postcode: String(x["postcode"]) } : {}),
    ...(x["price_cents"] != null ? { priceCents: num(x["price_cents"]) } : {}), ...(x["bedrooms"] != null ? { bedrooms: num(x["bedrooms"]) } : {}),
    createdAt: iso(x["created_at"]), jurisdiction: String(x["jurisdiction"]).trim() as Jurisdiction
  };
}

/**
 * Rebuilds the daily rows for one listing (UTC days, last 90 or since it was created) from the raw records, and records its outcome once an
 * offer has been accepted. Safe to repeat: rows are replaced, never added to.
 */
export async function refreshListingSnapshots(db: Queryable, listingId: string, now: string): Promise<void> {
  const today = now.slice(0, 10);
  await db.query(
    `WITH first_offer AS (SELECT min(submitted_at)::date AS d FROM formal_offer WHERE listing_id = $1::uuid)
     INSERT INTO listing_performance_daily_snapshot (listing_id, snapshot_date, views, inquiries, offers, time_to_offer_days, updated_at)
     SELECT l.id, g::date,
       (SELECT count(*) FROM listing_view v WHERE v.listing_id = l.id AND (v.viewed_at AT TIME ZONE 'UTC')::date = g::date),
       (SELECT count(*) FROM enquiry e WHERE e.listing_id = l.id AND (e.created_at AT TIME ZONE 'UTC')::date = g::date),
       (SELECT count(*) FROM formal_offer o WHERE o.listing_id = l.id AND (o.submitted_at AT TIME ZONE 'UTC')::date = g::date),
       CASE WHEN g::date = (SELECT d FROM first_offer) THEN GREATEST(0, g::date - (l.created_at AT TIME ZONE 'UTC')::date) END,
       $2::timestamptz
     FROM property_listing l, generate_series(GREATEST((l.created_at AT TIME ZONE 'UTC')::date, $3::date - ${HISTORY_DAYS - 1}), $3::date, interval '1 day') g
     WHERE l.id = $1::uuid
     ON CONFLICT (listing_id, snapshot_date) DO UPDATE SET views = EXCLUDED.views, inquiries = EXCLUDED.inquiries, offers = EXCLUDED.offers,
       time_to_offer_days = EXCLUDED.time_to_offer_days, updated_at = EXCLUDED.updated_at`,
    [listingId, now, today]);
  await db.query(
    `INSERT INTO listing_performance_outcome (listing_id, accepted_price_cents, days_to_first_offer, days_to_acceptance, total_views, total_inquiries, total_offers, recorded_at)
     SELECT l.id, a.price_cents,
       GREATEST(0, (SELECT min(submitted_at) FROM formal_offer WHERE listing_id = l.id)::date - (l.created_at AT TIME ZONE 'UTC')::date),
       GREATEST(0, a.at::date - (l.created_at AT TIME ZONE 'UTC')::date),
       (SELECT count(*) FROM listing_view WHERE listing_id = l.id), (SELECT count(*) FROM enquiry WHERE listing_id = l.id),
       (SELECT count(*) FROM formal_offer WHERE listing_id = l.id), $2::timestamptz
     FROM property_listing l
     JOIN LATERAL (
       SELECT o.price_cents, COALESCE((SELECT max(ev.occurred_at) FROM offer_event ev WHERE ev.offer_id = o.id AND ev.event_type = 'accepted'), o.submitted_at) AS at
       FROM formal_offer o WHERE o.listing_id = l.id AND o.status = 'accepted' ORDER BY o.submitted_at DESC LIMIT 1) a ON true
     WHERE l.id = $1::uuid
     ON CONFLICT (listing_id) DO UPDATE SET accepted_price_cents = EXCLUDED.accepted_price_cents, days_to_first_offer = EXCLUDED.days_to_first_offer,
       days_to_acceptance = EXCLUDED.days_to_acceptance, total_views = EXCLUDED.total_views, total_inquiries = EXCLUDED.total_inquiries,
       total_offers = EXCLUDED.total_offers, recorded_at = EXCLUDED.recorded_at`,
    [listingId, now]);
}

/** Refreshes a listing unless it was refreshed within the freshness window. Returns true when it rebuilt. */
export async function ensureFreshSnapshots(db: Queryable, listingId: string, now: string): Promise<boolean> {
  const r = (await db.query("SELECT max(updated_at) AS at FROM listing_performance_daily_snapshot WHERE listing_id = $1::uuid", [listingId])).rows[0];
  const at = r?.["at"] ? Date.parse(iso(r["at"])) : 0;
  if (at && Date.parse(now) - at < SNAPSHOT_FRESH_MS && day(new Date(at)) === now.slice(0, 10)) return false;
  await refreshListingSnapshots(db, listingId, now);
  return true;
}

export async function loadPoints(db: Queryable, listingId: string, now: string): Promise<DayPoint[]> {
  const r = await db.query(
    "SELECT snapshot_date, views, inquiries, offers FROM listing_performance_daily_snapshot WHERE listing_id = $1::uuid AND snapshot_date > $2::date - $3::int ORDER BY snapshot_date",
    [listingId, now.slice(0, 10), HISTORY_DAYS]);
  return r.rows.map(x => ({ date: day(x["snapshot_date"]), views: num(x["views"]), inquiries: num(x["inquiries"]), offers: num(x["offers"]) }));
}

/** Other published sale listings in the same suburb or postcode, with their own last-30-day figures read from the raw records. */
export async function loadCandidates(db: Queryable, s: Subject & { id: string }, now: string): Promise<CandidateListing[]> {
  const r = await db.query(
    `SELECT l.id, l.property_type, l.suburb, l.postcode, l.price_cents, l.bedrooms, l.created_at,
       (SELECT count(*) FROM listing_view v WHERE v.listing_id = l.id AND v.viewed_at > $2::timestamptz - interval '30 days' AND v.viewed_at <= $2::timestamptz) AS views30,
       (SELECT count(*) FROM enquiry e WHERE e.listing_id = l.id AND e.created_at > $2::timestamptz - interval '30 days' AND e.created_at <= $2::timestamptz) AS inquiries30,
       (SELECT count(*) FROM formal_offer o WHERE o.listing_id = l.id AND o.submitted_at > $2::timestamptz - interval '30 days' AND o.submitted_at <= $2::timestamptz) AS offers30,
       (SELECT min(o.submitted_at)::date - (l.created_at AT TIME ZONE 'UTC')::date FROM formal_offer o WHERE o.listing_id = l.id) AS days_to_first_offer
     FROM property_listing l
     WHERE l.status = 'published' AND l.deleted_at IS NULL AND l.transaction_type = 'sale' AND l.id <> $1::uuid
       AND ((lower(l.suburb) = lower($3) AND $3 <> '') OR ($3 = '' AND l.postcode = $4 AND $4 <> ''))
     ORDER BY l.created_at DESC LIMIT ${CANDIDATE_LIMIT}`,
    [s.id, now, s.suburb ?? "", s.postcode ?? ""]);
  return r.rows.map((x): CandidateListing => ({
    id: String(x["id"]), propertyType: String(x["property_type"]), ...(x["suburb"] ? { suburb: String(x["suburb"]) } : {}), ...(x["postcode"] ? { postcode: String(x["postcode"]) } : {}),
    ...(x["price_cents"] != null ? { priceCents: num(x["price_cents"]) } : {}), ...(x["bedrooms"] != null ? { bedrooms: num(x["bedrooms"]) } : {}),
    ageDays: ageDays(iso(x["created_at"]), now), views30: num(x["views30"]), inquiries30: num(x["inquiries30"]), offers30: num(x["offers30"]),
    ...(x["days_to_first_offer"] != null ? { daysToFirstOffer: Math.max(0, num(x["days_to_first_offer"])) } : {})
  }));
}

async function loadHeatmap(db: Queryable, listingId: string, now: string, tz: string): Promise<Heatmap | Unavailable> {
  const r = await db.query(
    `SELECT EXTRACT(dow FROM viewed_at AT TIME ZONE $3)::int AS dow, (EXTRACT(hour FROM viewed_at AT TIME ZONE $3)::int / 4) AS block, count(*)::int AS n
     FROM listing_view WHERE listing_id = $1::uuid AND viewed_at > $2::timestamptz - interval '90 days' AND viewed_at <= $2::timestamptz GROUP BY 1, 2`,
    [listingId, now, tz]);
  return buildHeatmap(r.rows.map(x => ({ dow: num(x["dow"]), block: num(x["block"]), n: num(x["n"]) })));
}

export interface PerformanceReport {
  listing: { id: string; title: string; status: string; ageDays: number; priceCents: number | null; photoCount: number };
  /** Days from listing to the first offer; null when there is none yet. */
  daysToFirstOffer: number | null;
  windows: WindowStats[];
  daily: DayPoint[];
  market: MarketComparison | Unavailable;
  heatmap: Heatmap | Unavailable;
  advice: Advice;
  asOf: string;
  note: string;
}

export async function buildReport(db: Queryable, f: ListingFacts, now: string): Promise<PerformanceReport> {
  await ensureFreshSnapshots(db, f.id, now);
  const points = await loadPoints(db, f.id, now);
  const age = ageDays(f.createdAt, now);
  const windows = windowStats(points, now, f.createdAt);
  const stats30 = windows.find(w => w.days === 30)!;
  const subject: Subject & { id: string } = { id: f.id, propertyType: f.propertyType, suburb: f.suburb, postcode: f.postcode, priceCents: f.priceCents, bedrooms: f.bedrooms };

  // Cached for a day: the comparison and heatmap. The gap figures are recomputed against the seller's fresh numbers each time.
  let cached: { heatmap: Heatmap | Unavailable; candidates: CandidateListing[] } | undefined;
  try {
    const c = (await db.query("SELECT market, heatmap, calculated_at FROM listing_performance_cache WHERE listing_id = $1::uuid", [f.id])).rows[0];
    if (c && Date.parse(now) - Date.parse(iso(c["calculated_at"])) < MARKET_FRESH_MS) {
      const m = c["market"] as { candidates?: CandidateListing[] };
      if (Array.isArray(m?.candidates)) cached = { heatmap: c["heatmap"] as Heatmap | Unavailable, candidates: m.candidates };
    }
  } catch { /* fall through to a fresh calculation */ }
  if (!cached) {
    const fresh = { heatmap: await loadHeatmap(db, f.id, now, JURISDICTION_TIME_ZONE[f.jurisdiction] ?? "Australia/Sydney"), candidates: await loadCandidates(db, subject, now) };
    cached = fresh;
    try {
      await db.query(
        `INSERT INTO listing_performance_cache (listing_id, market, heatmap, calculated_at) VALUES ($1::uuid,$2::jsonb,$3::jsonb,$4::timestamptz)
         ON CONFLICT (listing_id) DO UPDATE SET market = EXCLUDED.market, heatmap = EXCLUDED.heatmap, calculated_at = EXCLUDED.calculated_at`,
        [f.id, JSON.stringify({ candidates: fresh.candidates }), JSON.stringify(fresh.heatmap), now]);
    } catch { /* cache is best effort */ }
  }
  const market = marketComparison(subject, stats30, cached.candidates);
  const photoCount = num((await db.query("SELECT count(*)::int AS n FROM listing_photo WHERE listing_id = $1::uuid AND kind = 'photo'", [f.id])).rows[0]?.["n"]);
  const offersEver = num((await db.query("SELECT count(*)::int AS n FROM formal_offer WHERE listing_id = $1::uuid", [f.id])).rows[0]?.["n"]);
  const dtf = (await db.query("SELECT min(time_to_offer_days) AS d FROM listing_performance_daily_snapshot WHERE listing_id = $1::uuid", [f.id])).rows[0]?.["d"];
  const advice = elenaAdvice({ subject, ageDays: age, photoCount, stats30, offersEver, market, candidates: cached.candidates });
  return {
    listing: { id: f.id, title: f.title, status: f.status, ageDays: age, priceCents: f.priceCents ?? null, photoCount },
    daysToFirstOffer: dtf == null ? null : num(dtf), windows, daily: fillDays(points, now, 90), market, heatmap: cached.heatmap, advice, asOf: now, note: PERFORMANCE_NOTE
  };
}

// ---- Staff: platform view ----

export interface StaffListingRow { id: string; title: string; suburb?: string; ageDays: number; views30: number; inquiries30: number; offers30: number; flag?: string }
export interface StaffReport {
  asOf: string; listings: number;
  totals30: { views: number; inquiries: number; offers: number; inquiryRatePct: number | null; offersPer100Views: number | null };
  medianDaysToFirstOffer?: number | undefined; medianDaysToAcceptance?: number | undefined; outcomes: number;
  daily: DayPoint[];
  needsAttention: StaffListingRow[];
  note: string;
}
const STAFF_REFRESH_LIMIT = 100;

/** Refreshes up to 100 published listings whose rows are missing or from before today, then reads every published sale listing's figures. */
export async function buildStaffReport(db: Queryable, now: string): Promise<StaffReport> {
  const stale = await db.query(
    `SELECT l.id FROM property_listing l WHERE l.status = 'published' AND l.deleted_at IS NULL AND l.transaction_type = 'sale'
       AND COALESCE((SELECT max(updated_at) FROM listing_performance_daily_snapshot s WHERE s.listing_id = l.id), 'epoch'::timestamptz) < $1::timestamptz - interval '1 hour'
     ORDER BY l.created_at DESC LIMIT ${STAFF_REFRESH_LIMIT}`, [now]);
  for (const x of stale.rows) await refreshListingSnapshots(db, String(x["id"]), now).catch(() => undefined);
  const today = now.slice(0, 10);
  const rows = await db.query(
    `SELECT l.id, l.title, l.suburb, l.created_at,
       COALESCE(SUM(s.views),0)::int AS views30, COALESCE(SUM(s.inquiries),0)::int AS inquiries30, COALESCE(SUM(s.offers),0)::int AS offers30
     FROM property_listing l LEFT JOIN listing_performance_daily_snapshot s ON s.listing_id = l.id AND s.snapshot_date > $1::date - 30
     WHERE l.status = 'published' AND l.deleted_at IS NULL AND l.transaction_type = 'sale' GROUP BY l.id`, [today]);
  const listings = rows.rows.map((x): StaffListingRow => ({
    id: String(x["id"]), title: String(x["title"]), ...(x["suburb"] ? { suburb: String(x["suburb"]) } : {}), ageDays: ageDays(iso(x["created_at"]), now),
    views30: num(x["views30"]), inquiries30: num(x["inquiries30"]), offers30: num(x["offers30"])
  }));
  const sum = (k: "views30" | "inquiries30" | "offers30") => listings.reduce((a, l) => a + l[k], 0);
  const views = sum("views30"), inquiries = sum("inquiries30"), offers = sum("offers30");
  const r1 = (n: number) => Math.round(n * 10) / 10;
  // Needs attention: live 14+ days and under half the median views of listings in the same suburb (three or more), or enquiries at zero despite 20+ views.
  const bySuburb = new Map<string, number[]>();
  for (const l of listings) if (l.suburb) bySuburb.set(l.suburb.toLowerCase(), [...(bySuburb.get(l.suburb.toLowerCase()) ?? []), l.views30]);
  const needsAttention = listings.flatMap((l): StaffListingRow[] => {
    if (l.ageDays < 14 || l.offers30 > 0) return [];
    const peers = l.suburb ? bySuburb.get(l.suburb.toLowerCase()) ?? [] : [];
    const med = peers.length >= 3 ? median(peers) : undefined;
    if (l.views30 >= 20 && l.inquiries30 === 0) return [{ ...l, flag: "Views but no enquiries" }];
    if (med !== undefined && med > 0 && l.views30 < med * 0.5) return [{ ...l, flag: "Under half the suburb's typical views" }];
    return [];
  }).sort((a, b) => a.views30 - b.views30 || a.id.localeCompare(b.id)).slice(0, 25);
  const daily = (await db.query(
    `SELECT s.snapshot_date, SUM(s.views)::int AS views, SUM(s.inquiries)::int AS inquiries, SUM(s.offers)::int AS offers
     FROM listing_performance_daily_snapshot s JOIN property_listing l ON l.id = s.listing_id
     WHERE l.status = 'published' AND l.deleted_at IS NULL AND s.snapshot_date > $1::date - 90 GROUP BY 1 ORDER BY 1`, [today])).rows
    .map(x => ({ date: day(x["snapshot_date"]), views: num(x["views"]), inquiries: num(x["inquiries"]), offers: num(x["offers"]) }));
  const out = (await db.query("SELECT days_to_first_offer, days_to_acceptance FROM listing_performance_outcome")).rows;
  const dFirst = median(out.flatMap(x => (x["days_to_first_offer"] != null ? [num(x["days_to_first_offer"])] : [])));
  const dAccept = median(out.flatMap(x => (x["days_to_acceptance"] != null ? [num(x["days_to_acceptance"])] : [])));
  return {
    asOf: now, listings: listings.length,
    totals30: { views, inquiries, offers, inquiryRatePct: views >= 20 ? r1((inquiries / views) * 100) : null, offersPer100Views: views >= 20 ? r1((offers / views) * 100) : null },
    ...(dFirst !== undefined ? { medianDaysToFirstOffer: Math.round(dFirst) } : {}), ...(dAccept !== undefined ? { medianDaysToAcceptance: Math.round(dAccept) } : {}),
    outcomes: out.length, daily: fillDays(daily, now, 90), needsAttention, note: PERFORMANCE_NOTE
  };
}
