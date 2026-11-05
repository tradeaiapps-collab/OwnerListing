import { NextResponse } from "next/server";
import { parseComparables, type Comparable, type ComparablesSource, type Subject } from "../domain/price-guidance";
import {
  findComparableProperties, INTEL_RATE, marketInsights, parseIntelQuery, valueProperty, valueTrend, type IntelBundle, type IntelQuery
} from "../domain/property-intelligence";
import { windowStart, withinLimit } from "../domain/rate-limit";
import { getActor, getDb, getDeps } from "./context";
import type { Queryable } from "./db";
import { countHitPg } from "./offer-flow-db";
import { getComparablesSource } from "./price-guidance";

const NO_STORE = { "cache-control": "no-store" } as const;
const LOOKBACK_MONTHS = 26;

/**
 * Sales and leases recorded on the property history (property_event 'sold' / 'rented', not voided), by suburb or postcode, last 26 months.
 * Platform and public-record rows, plus licensed third-party rows from a feed connection whose recorded licence allows comparables
 * (feed_connection.comparables_licensed). Owner-supplied figures are unverified and other third-party rows may not be reusable.
 * Days on the market runs from the property's first 'listed' event in the year before the sale. Parameterised SQL only.
 */
export function createPlatformComparablesSource(db: Queryable): ComparablesSource {
  return {
    id: "platform",
    async find(subject: Subject, now: string) {
      try {
        const since = new Date(Date.parse(now) - LOOKBACK_MONTHS * 30.44 * 86_400_000).toISOString();
        const r = await db.query(
          `SELECT e.id, e.event_type, e.amount_cents, e.occurred_at, p.suburb, p.postcode, p.property_type, p.bedrooms, p.bathrooms, p.car_spaces, p.land_area_sqm,
                  (SELECT min(l.occurred_at) FROM property_event l
                    WHERE l.property_id = e.property_id AND l.event_type = 'listed' AND l.occurred_at <= e.occurred_at
                      AND (l.source IN ('platform','public_record') OR (l.source = 'licensed_third_party' AND EXISTS (
                            SELECT 1 FROM feed_connection lf WHERE lf.id = l.feed_connection_id AND lf.comparables_licensed)))
                      AND l.occurred_at > e.occurred_at - interval '365 days') AS listed_at
             FROM property_event e JOIN property p ON p.id = e.property_id
            WHERE e.event_type IN ('sold','rented') AND e.voided_at IS NULL AND e.amount_cents > 0 AND e.occurred_at >= $1::timestamptz AND e.occurred_at <= $2::timestamptz
              AND (e.source IN ('platform','public_record') OR (e.source = 'licensed_third_party' AND EXISTS (
                    SELECT 1 FROM feed_connection f WHERE f.id = e.feed_connection_id AND f.comparables_licensed)))
              AND p.property_type IS NOT NULL AND p.suburb IS NOT NULL
              AND (($3::text IS NOT NULL AND lower(p.suburb) = lower($3::text)) OR ($4::text IS NOT NULL AND p.postcode = $4::text))
            ORDER BY e.occurred_at DESC LIMIT 2000`,
          [since, now, subject.suburb ?? null, subject.postcode ?? null]
        );
        const rows = r.rows.map(x => {
          const at = new Date(String(x["occurred_at"])).getTime();
          const listed = x["listed_at"] ? new Date(String(x["listed_at"])).getTime() : undefined;
          return {
            id: `platform:${String(x["id"])}`, transactionType: x["event_type"] === "rented" ? "rent" : "sale", propertyType: x["property_type"],
            priceCents: Number(x["amount_cents"]), date: new Date(at).toISOString(), suburb: x["suburb"],
            ...(x["postcode"] ? { postcode: String(x["postcode"]).trim() } : {}),
            ...(x["bedrooms"] != null ? { bedrooms: Number(x["bedrooms"]) } : {}), ...(x["bathrooms"] != null ? { bathrooms: Number(x["bathrooms"]) } : {}),
            ...(x["car_spaces"] != null ? { parking: Number(x["car_spaces"]) } : {}), ...(x["land_area_sqm"] != null ? { areaSqm: Number(x["land_area_sqm"]) } : {}),
            ...(listed !== undefined && at >= listed ? { daysOnMarket: Math.round((at - listed) / 86_400_000) } : {})
          };
        });
        return parseComparables(rows);
      } catch {
        return [];
      }
    }
  };
}

/** Combines sources; the same id from two sources counts once. A failing source gives nothing, never an error. */
export function combineSources(sources: readonly ComparablesSource[]): ComparablesSource {
  return {
    id: sources.map(s => s.id).join("+"),
    async find(subject, now) {
      const seen = new Set<string>();
      const out: Comparable[] = [];
      for (const rows of await Promise.all(sources.map(s => s.find(subject, now).catch(() => [] as Comparable[])))) {
        for (const c of rows) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
      }
      return out;
    }
  };
}

/** PRICE_DATA_SOURCE (file or licensed export) plus the platform's own recorded sales. */
export function getIntelligenceSource(db: Queryable, env: Record<string, string | undefined> = process.env): ComparablesSource {
  return combineSources([getComparablesSource(env), createPlatformComparablesSource(db)]);
}

export function buildBundle(query: IntelQuery, comps: readonly Comparable[], now: string): IntelBundle {
  return {
    query, valuation: valueProperty(query, comps, now), market: marketInsights(query, comps, now),
    trend: valueTrend(query, comps, now), comparables: findComparableProperties(query, comps, now, 10)
  };
}

export type IntelContext = { query: IntelQuery; comps: Comparable[]; now: string; userId: string };

/**
 * Shared front door for the intelligence routes: signed-in users only (the figures are advisory and scraping them is not allowed),
 * per-user hourly limit that fails closed, then the query and the comparables.
 */
export async function loadIntel(req: Request, get: (k: string) => string | number | null | undefined): Promise<IntelContext | NextResponse> {
  const actor = await getActor(req).catch(() => null);
  if (!actor) return NextResponse.json({ error: "Sign in to see property intelligence." }, { status: 401, headers: NO_STORE });
  const parsed = parseIntelQuery(get);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });
  const db = getDb();
  const now = getDeps().now();
  let hits: number | undefined;
  try { hits = await countHitPg(db, `intel:${actor.userId}`, windowStart(now, INTEL_RATE.windowMs)); } catch { hits = undefined; }
  if (!withinLimit(hits, INTEL_RATE.perUser)) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "600" } });
  const comps = await getIntelligenceSource(db).find(parsed.query, now).catch(() => []);
  return { query: parsed.query, comps, now, userId: actor.userId };
}

export const noStore = NO_STORE;
