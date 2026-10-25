import { ANALYTICS_TIME_ZONE } from "../domain/admin-analytics";
import type { Dimension, RawReportRow, ReportQuery } from "../domain/admin-report-builder";
import type { Queryable } from "./db";

/**
 * Grouping expression per dimension, from this fixed list only. The agent for a listing is its current (latest unrevoked) appointed
 * agent, else the owner when the owner is an agent, else 'none'.
 */
const GROUP: Record<Dimension, string> = {
  category: "l.property_type",
  transaction: "l.transaction_type",
  region: "l.jurisdiction::text",
  suburb: "COALESCE(initcap(btrim(l.suburb)), '')",
  agent: "COALESCE(a.agent_user_id::text, CASE WHEN o.user_type = 'agent' THEN o.id::text END, 'none')"
};

/**
 * One row per group for listings created in the period. Offers and accepted offers count offers submitted in the period on any listing
 * in the group; revenue sums listing invoices paid in the period. "Live now" is the listing's current status.
 */
export async function loadReport(db: Queryable, q: ReportQuery): Promise<RawReportRow[]> {
  const g = GROUP[q.dimension];
  const within = (col: string) => `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
  const res = await db.query(
    `WITH base AS (
       SELECT l.id, l.status, l.created_at, ${g} AS key
         FROM property_listing l
         JOIN app_user o ON o.id = l.owner_user_id
         LEFT JOIN LATERAL (SELECT agent_user_id FROM listing_agent_appointment x
                             WHERE x.listing_id = l.id AND x.revoked_at IS NULL ORDER BY x.appointed_at DESC LIMIT 1) a ON true
     ),
     offers AS (
       SELECT b.key, count(*)::int AS offers, count(*) FILTER (WHERE f.status = 'accepted')::int AS accepted
         FROM formal_offer f JOIN base b ON b.id = f.listing_id WHERE ${within("f.submitted_at")} GROUP BY b.key
     ),
     revenue AS (
       SELECT b.key, COALESCE(sum(i.total_cents), 0)::bigint AS cents
         FROM invoice i JOIN base b ON b.id = i.listing_id WHERE i.status = 'paid' AND ${within("i.paid_at")} GROUP BY b.key
     ),
     listings AS (
       SELECT key, count(*) FILTER (WHERE ${within("created_at")})::int AS created, count(*) FILTER (WHERE status = 'published')::int AS live
         FROM base GROUP BY key
     )
     SELECT l.key, l.created, l.live, COALESCE(o.offers, 0) AS offers, COALESCE(o.accepted, 0) AS accepted, COALESCE(r.cents, 0)::text AS cents
            ${q.dimension === "agent" ? ", (SELECT display_name FROM app_user u WHERE u.id::text = l.key) AS agent_name" : ""}
       FROM listings l LEFT JOIN offers o ON o.key = l.key LEFT JOIN revenue r ON r.key = l.key
      WHERE l.created > 0 OR COALESCE(o.offers, 0) > 0 OR COALESCE(r.cents, 0) > 0
      ORDER BY l.key LIMIT 500`,
    [q.range.from, q.range.to, ANALYTICS_TIME_ZONE]
  );
  return res.rows.map(r => ({
    key: String(r["key"] ?? ""),
    ...(q.dimension === "agent" ? { agentName: typeof r["agent_name"] === "string" ? r["agent_name"] : null } : {}),
    listingsCreated: Number(r["created"] ?? 0), liveNow: Number(r["live"] ?? 0), offers: Number(r["offers"] ?? 0),
    accepted: Number(r["accepted"] ?? 0), revenueCents: Number(r["cents"] ?? 0)
  }));
}
