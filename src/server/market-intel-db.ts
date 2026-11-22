import { randomUUID } from "node:crypto";
import { demandOutlook, detectMarketShifts, marketAt, type DemandFacts } from "../domain/market-forecast";
import { marketInsights, type IntelQuery } from "../domain/property-intelligence";
import type { Subject } from "../domain/price-guidance";
import type { Queryable } from "./db";
import { appendAuditPg } from "./db";
import { notifyUser } from "./notifier";
import { getIntelligenceSource } from "./property-intelligence";

const WEEKS = 8;
const WEEK_S = 7 * 86_400;

/**
 * Weekly buyer activity for one area: saves, enquiries and offers on listings in the suburb or postcode, last eight weeks, oldest first,
 * plus the number of published listings now. Counts only: no buyer, owner or price data leaves the database. Parameterised SQL.
 */
export async function loadDemandFacts(db: Queryable, s: Subject, now: string): Promise<DemandFacts | undefined> {
  if (!s.suburb && !s.postcode) return undefined;
  const area = `l.transaction_type = $3 AND (($1::text IS NOT NULL AND lower(btrim(l.suburb)) = lower(btrim($1::text))) OR ($2::text IS NOT NULL AND l.postcode = $2::text))`;
  const bucket = (col: string) => `floor(extract(epoch FROM ($4::timestamptz - ${col})) / ${WEEK_S})::int`;
  const win = (col: string) => `${col} <= $4::timestamptz AND ${col} > $4::timestamptz - interval '${WEEKS} weeks'`;
  const r = await db.query(
    `SELECT 'saves' AS k, ${bucket("s.created_at")} AS b, count(*)::int AS n FROM saved_listing s JOIN property_listing l ON l.id = s.listing_id WHERE ${area} AND ${win("s.created_at")} GROUP BY 1, 2
     UNION ALL
     SELECT 'enquiries', ${bucket("e.created_at")}, count(*)::int FROM enquiry e JOIN property_listing l ON l.id = e.listing_id WHERE ${area} AND ${win("e.created_at")} GROUP BY 1, 2
     UNION ALL
     SELECT 'offers', ${bucket("o.submitted_at")}, count(*)::int FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id WHERE ${area} AND ${win("o.submitted_at")} GROUP BY 1, 2
     UNION ALL
     SELECT 'active', 0, count(*)::int FROM property_listing l WHERE ${area} AND l.status = 'published'`,
    [s.suburb ?? null, s.postcode ?? null, s.transactionType, now]
  );
  const weeks = Array.from({ length: WEEKS }, () => ({ saves: 0, enquiries: 0, offers: 0 }));
  let active = 0;
  for (const x of r.rows) {
    const k = String(x["k"]), n = Number(x["n"] ?? 0), b = Number(x["b"] ?? 0);
    if (k === "active") { active = n; continue; }
    const w = weeks[WEEKS - 1 - b];
    if (w && (k === "saves" || k === "enquiries" || k === "offers")) w[k] += n;
  }
  return { weeks, activeListings: active };
}

export interface ShiftRunResult { areas: number; shifts: number; notified: number }
const MAX_AREAS = 500;
const monthKey = (iso: string) => iso.slice(0, 7);

/**
 * Elena's proactive market-shift alerts. For each area where an agent has an active appointment (published listing, same suburb, property
 * type and sale/rent), compares the market now with a month ago and tells the agent about notable changes. Each shift is sent once per
 * agent, area, kind and month (unique row), through the agent's own notification settings. Facts only, never advice.
 */
export async function runMarketShiftAlerts(db: Queryable, now: string, env: Record<string, string | undefined> = process.env): Promise<ShiftRunResult> {
  const rows = (await db.query(
    `SELECT l.suburb, l.postcode, l.property_type, l.transaction_type, array_agg(DISTINCT a.agent_user_id::text) AS agents
       FROM listing_agent_appointment a JOIN property_listing l ON l.id = a.listing_id
      WHERE a.revoked_at IS NULL AND l.status = 'published' AND l.suburb IS NOT NULL AND btrim(l.suburb) <> ''
      GROUP BY l.suburb, l.postcode, l.property_type, l.transaction_type
      ORDER BY l.suburb, l.property_type LIMIT $1`, [MAX_AREAS])).rows;
  const source = getIntelligenceSource(db, env);
  const out: ShiftRunResult = { areas: 0, shifts: 0, notified: 0 };
  for (const x of rows) {
    const subject: IntelQuery = {
      transactionType: x["transaction_type"] === "rent" ? "rent" : "sale", propertyType: String(x["property_type"]), suburb: String(x["suburb"]),
      ...(x["postcode"] ? { postcode: String(x["postcode"]).trim() } : {})
    };
    try {
      const comps = await source.find(subject, now);
      const demand = await loadDemandFacts(db, subject, now).then(f => (f ? demandOutlook(f) : undefined)).catch(() => undefined);
      const area = `${subject.suburb} ${subject.propertyType === "unit" ? "units" : subject.propertyType === "house" ? "houses" : subject.propertyType}${subject.transactionType === "rent" ? " (rent)" : ""}`;
      const shifts = detectMarketShifts({ area, now: marketInsights(subject, comps, now), before: marketAt(subject, comps, now, 1), demand });
      out.areas++;
      const agents: string[] = Array.isArray(x["agents"]) ? (x["agents"] as unknown[]).map(String) : [];
      const areaKey = `${subject.transactionType}|${subject.propertyType}|${subject.suburb!.toLowerCase()}|${subject.postcode ?? ""}`.slice(0, 200);
      for (const shift of shifts) {
        out.shifts++;
        for (const agent of agents) {
          const ins = await db.query(
            `INSERT INTO market_shift_alert (agent_user_id, area_key, shift_kind, period_month, severity) VALUES ($1::uuid, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING RETURNING id`, [agent, areaKey, shift.kind, monthKey(now), shift.severity]);
          if (ins.rows.length === 0) continue;
          const res = await notifyUser(db, agent, "market_shift", { title: shift.title, text: shift.text, link: "/market" }, env);
          if (res.inApp || res.email === "sent") out.notified++;
          await appendAuditPg(db, {
            id: randomUUID(), occurredAt: now, actorType: "system", actorId: "elena-market-shifts", aggregateType: "user", aggregateId: agent,
            eventType: "market_shift.alerted", correlationId: randomUUID(), payload: { areaKey, kind: shift.kind, severity: shift.severity }
          });
        }
      }
    } catch {
      // One area failing never stops the others.
    }
  }
  return out;
}
