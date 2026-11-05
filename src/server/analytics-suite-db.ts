import { ANALYTICS_TIME_ZONE } from "../domain/admin-analytics";
import type { AgentMetricFacts } from "../domain/agent-benchmark";
import type { SaleFact } from "../domain/area-forecast";
import type { Queryable } from "./db";

/**
 * Reads for the analytics suite (market forecast, agent benchmarks, team trends). Constant SQL; dates, ids and the zone travel only as
 * bound parameters. Days and months are calendar dates in the reporting zone. No buyer data is selected.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const num = (v: unknown) => (v == null ? undefined : Number(v));

/**
 * Recorded sales (property_event 'sold', not voided) from `sinceMonth` (YYYY-MM) on, with the property's suburb and type. Same source rule
 * as comparables: platform and public-record rows, plus licensed third-party rows whose feed allows comparables.
 */
export async function loadSaleFacts(db: Queryable, sinceMonth: string): Promise<SaleFact[]> {
  const r = await db.query(
    `SELECT to_char(e.occurred_at AT TIME ZONE $2, 'YYYY-MM') AS month, p.suburb, p.property_type, e.amount_cents
       FROM property_event e JOIN property p ON p.id = e.property_id
      WHERE e.event_type = 'sold' AND e.voided_at IS NULL AND e.amount_cents > 0
        AND e.occurred_at >= ($1::date)::timestamp AT TIME ZONE $2
        AND (e.source IN ('platform','public_record') OR (e.source = 'licensed_third_party' AND EXISTS (
              SELECT 1 FROM feed_connection f WHERE f.id = e.feed_connection_id AND f.comparables_licensed)))
        AND p.suburb IS NOT NULL AND p.property_type IS NOT NULL
      LIMIT 50000`,
    [`${sinceMonth}-01`, ANALYTICS_TIME_ZONE]
  );
  return r.rows.map(x => ({ month: String(x["month"]), suburb: String(x["suburb"]).trim(), propertyType: String(x["property_type"]), priceCents: Number(x["amount_cents"]) }));
}

/**
 * Agent facts between `from` and `to` (inclusive calendar days): every agent with an appointment, their sales, enquiries and commission.
 * With a team id, only that agency team's current members. An offer or enquiry is credited to the agent appointed to the listing at the
 * time it was made.
 */
export async function loadAgentFacts(db: Queryable, from: string, to: string, teamId?: string): Promise<AgentMetricFacts> {
  const params = [from, to, ANALYTICS_TIME_ZONE, teamId ?? null];
  const within = (col: string) => `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
  const inTeam = (col: string) => `($4::uuid IS NULL OR EXISTS (SELECT 1 FROM agency_team_member tm WHERE tm.team_id = $4::uuid AND tm.user_id = ${col} AND tm.removed_at IS NULL))`;
  const covers = (at: string) => `a.appointed_at <= ${at} AND (a.revoked_at IS NULL OR a.revoked_at > ${at})`;

  const [agents, sales, enquiries, commissions] = await Promise.all([
    db.query(
      `SELECT u.id, u.display_name, min(a.appointed_at) AS first_appointed,
              (SELECT l2.suburb FROM listing_agent_appointment a2 JOIN property_listing l2 ON l2.id = a2.listing_id
                WHERE a2.agent_user_id = u.id AND l2.suburb IS NOT NULL GROUP BY l2.suburb ORDER BY count(*) DESC, l2.suburb LIMIT 1) AS area_display,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price_cents) FILTER (WHERE l.transaction_type = 'sale' AND l.price_cents IS NOT NULL) AS median_list
         FROM app_user u JOIN listing_agent_appointment a ON a.agent_user_id = u.id JOIN property_listing l ON l.id = a.listing_id
        WHERE u.user_type = 'agent' AND ${inTeam("u.id")} AND a.appointed_at < ($2::date + 1)::timestamp AT TIME ZONE $3
          AND $1::date IS NOT NULL -- every query shares one parameter list; this keeps $1 typed
        GROUP BY u.id, u.display_name`,
      params
    ),
    db.query(
      `SELECT a.agent_user_id, to_char(o.submitted_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, o.price_cents, l.price_cents AS list_cents,
              EXTRACT(EPOCH FROM (o.submitted_at - COALESCE(
                (SELECT min(ae.occurred_at) FROM audit_event ae WHERE ae.aggregate_type = 'listing' AND ae.aggregate_id = l.id::text AND ae.event_type = 'listing.published'),
                l.created_at))) / 86400 AS dom
         FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id AND l.transaction_type = 'sale'
         JOIN listing_agent_appointment a ON a.listing_id = o.listing_id AND ${covers("o.submitted_at")}
        WHERE o.status = 'accepted' AND ${within("o.submitted_at")} AND ${inTeam("a.agent_user_id")}`,
      params
    ),
    db.query(
      `SELECT a.agent_user_id, to_char(e.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, count(*) AS enquiries,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM formal_offer o WHERE o.listing_id = e.listing_id AND o.buyer_user_id = e.buyer_user_id)) AS converted
         FROM enquiry e JOIN listing_agent_appointment a ON a.listing_id = e.listing_id AND ${covers("e.created_at")}
        WHERE ${within("e.created_at")} AND ${inTeam("a.agent_user_id")}
        GROUP BY 1, 2`,
      params
    ),
    db.query(
      `SELECT d.agent_user_id, to_char(d.deal_date, 'YYYY-MM-DD') AS day, sum(COALESCE(d.override_cents, d.calculated_cents)) AS cents
         FROM commission_deal d
        WHERE d.status <> 'cancelled' AND d.deal_date BETWEEN $1::date AND $2::date AND ${inTeam("d.agent_user_id")}
          AND $3::text IS NOT NULL -- every query shares one parameter list; this keeps $3 typed
        GROUP BY 1, 2`,
      params
    )
  ]);

  return {
    agents: agents.rows.map(x => ({
      agentId: String(x["id"]), name: String(x["display_name"]), firstAppointedAt: iso(x["first_appointed"]),
      ...(x["area_display"] ? { primaryArea: String(x["area_display"]) } : {}),
      ...(x["median_list"] != null ? { medianListCents: Math.round(Number(x["median_list"])) } : {})
    })),
    sales: sales.rows.map(x => {
      const list = num(x["list_cents"]), dom = num(x["dom"]);
      return {
        agentId: String(x["agent_user_id"]), date: String(x["day"]), priceCents: Number(x["price_cents"]),
        ...(list !== undefined ? { listCents: list } : {}), ...(dom !== undefined && dom >= 0 ? { daysOnMarket: Math.floor(dom) } : {})
      };
    }),
    enquiries: enquiries.rows.map(x => ({ agentId: String(x["agent_user_id"]), date: String(x["day"]), enquiries: Number(x["enquiries"]), converted: Number(x["converted"]) })),
    commissions: commissions.rows.map(x => ({ agentId: String(x["agent_user_id"]), date: String(x["day"]), cents: Number(x["cents"]) }))
  };
}

/** Agency teams for the scope picker (names only). */
export async function listAgencyTeams(db: Queryable): Promise<{ id: string; name: string }[]> {
  const r = await db.query(`SELECT id, name FROM agency_team ORDER BY lower(name), id LIMIT 200`);
  return r.rows.map(x => ({ id: String(x["id"]), name: String(x["name"]) }));
}
