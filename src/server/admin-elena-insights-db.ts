import { median } from "../domain/agent-workspace";
import { ANALYTICS_TIME_ZONE, type Range } from "../domain/admin-analytics";
import { UNANSWERED_HOURS, type AgentFact, type AreaFact, type InsightFacts, type PeriodCounts } from "../domain/admin-elena-insights";
import type { Queryable } from "./db";
import { loadTeamFacts } from "./team-analytics-db";

const empty = (): PeriodCounts => ({ listings: 0, enquiries: 0, offers: 0, accepted: 0, decided: 0 });
const METRIC_FIELD: Record<string, keyof PeriodCounts> = { listings: "listings", enquiries: "enquiries", offers: "offers", accepted: "accepted", decided: "decided" };

/**
 * Counts for Elena's admin insights: the chosen period and the equal period just before it, by area, plus per-agent figures for agents
 * currently appointed to listings. Constant SQL; dates and zone are bound parameters. Grouped counts and agent display names only
 * (no buyer or owner data, no money). Periods are whole calendar days in the reporting zone.
 */
export async function loadInsightFacts(db: Queryable, r: Range, now: Date = new Date(), unansweredHours: number = UNANSWERED_HOURS): Promise<InsightFacts> {
  const win = `(SELECT 'current' AS w, ($1::date)::timestamp AT TIME ZONE $3 AS s, ($2::date + 1)::timestamp AT TIME ZONE $3 AS e
                UNION ALL
                SELECT 'previous', ($1::date - ($2::date - $1::date + 1))::timestamp AT TIME ZONE $3, ($1::date)::timestamp AT TIME ZONE $3) win`;
  const area = `l.jurisdiction::text AS jurisdiction, COALESCE(lower(btrim(l.suburb)), '') AS suburb`;
  const params = [r.from, r.to, ANALYTICS_TIME_ZONE];

  const areaRows = (await db.query(
    `SELECT win.w, ${area}, 'listings' AS metric, count(*)::bigint AS n FROM property_listing l JOIN ${win} ON l.created_at >= win.s AND l.created_at < win.e GROUP BY 1, 2, 3
     UNION ALL
     SELECT win.w, ${area}, 'enquiries', count(*) FROM enquiry e JOIN property_listing l ON l.id = e.listing_id JOIN ${win} ON e.created_at >= win.s AND e.created_at < win.e GROUP BY 1, 2, 3
     UNION ALL
     SELECT win.w, ${area}, 'offers', count(*) FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id JOIN ${win} ON o.submitted_at >= win.s AND o.submitted_at < win.e GROUP BY 1, 2, 3
     UNION ALL
     SELECT win.w, ${area}, 'accepted', count(*) FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id JOIN ${win} ON o.submitted_at >= win.s AND o.submitted_at < win.e
      WHERE o.status = 'accepted' GROUP BY 1, 2, 3
     UNION ALL
     SELECT win.w, ${area}, 'decided', count(*) FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id JOIN ${win} ON o.submitted_at >= win.s AND o.submitted_at < win.e
      WHERE o.status IN ('accepted', 'rejected') GROUP BY 1, 2, 3
     UNION ALL
     SELECT 'now', ${area}, 'published', count(*) FROM property_listing l WHERE l.status = 'published' GROUP BY 1, 2, 3`,
    params
  )).rows;

  const current = empty(), previous = empty();
  const byArea = new Map<string, AreaFact>();
  for (const x of areaRows) {
    const w = String(x["w"]), metric = String(x["metric"]), n = Number(x["n"] ?? 0);
    const suburb = String(x["suburb"]), jurisdiction = String(x["jurisdiction"]);
    const key = `${jurisdiction}|${suburb}`;
    let a = byArea.get(key);
    if (!a) { a = { jurisdiction, suburb: suburb || "unknown suburb", current: empty(), previous: empty(), publishedNow: 0 }; byArea.set(key, a); }
    if (w === "now") { a.publishedNow += n; continue; }
    const field = METRIC_FIELD[metric];
    if (!field) continue;
    (w === "current" ? a.current : a.previous)[field] += n;
    (w === "current" ? current : previous)[field] += n;
  }

  const cur = `WITH cur AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS s, ($2::date + 1)::timestamp AT TIME ZONE $3 AS e)`;
  const agentRows = (await db.query(
    `${cur}
     SELECT u.id, COALESCE(NULLIF(btrim(u.display_name), ''), 'Agent') AS name,
       (SELECT count(*) FROM listing_agent_appointment a WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL) AS listings,
       (SELECT count(*) FROM listing_agent_appointment a JOIN enquiry e ON e.listing_id = a.listing_id, cur
         WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL AND e.created_at >= cur.s AND e.created_at < cur.e) AS enquiries,
       (SELECT count(*) FROM listing_agent_appointment a JOIN enquiry e ON e.listing_id = a.listing_id, cur
         WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL AND e.created_at >= cur.s AND e.created_at < cur.e
           AND e.created_at < $4::timestamptz - make_interval(hours => $5::int)
           AND NOT EXISTS (SELECT 1 FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = u.id)) AS unanswered,
       (SELECT count(*) FROM listing_agent_appointment a JOIN formal_offer o ON o.listing_id = a.listing_id, cur
         WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL AND o.submitted_at >= cur.s AND o.submitted_at < cur.e) AS offers,
       (SELECT count(*) FROM listing_agent_appointment a JOIN formal_offer o ON o.listing_id = a.listing_id, cur
         WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL AND o.submitted_at >= cur.s AND o.submitted_at < cur.e AND o.status = 'accepted') AS accepted,
       (SELECT count(*) FROM listing_agent_appointment a JOIN formal_offer o ON o.listing_id = a.listing_id, cur
         WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL AND o.submitted_at >= cur.s AND o.submitted_at < cur.e AND o.status IN ('accepted','rejected')) AS decided
       FROM app_user u
      WHERE u.user_type = 'agent' AND EXISTS (SELECT 1 FROM listing_agent_appointment a WHERE a.agent_user_id = u.id AND a.revoked_at IS NULL)
      ORDER BY u.id LIMIT 200`,
    [...params, now.toISOString(), unansweredHours]
  )).rows;
  const resp = (await db.query(
    `${cur}
     SELECT a.agent_user_id AS id, EXTRACT(EPOCH FROM (min(m.sent_at) - e.created_at)) / 60 AS mins
       FROM cur CROSS JOIN listing_agent_appointment a JOIN enquiry e ON e.listing_id = a.listing_id
       JOIN enquiry_message m ON m.enquiry_id = e.id AND m.sender_user_id = a.agent_user_id
      WHERE a.revoked_at IS NULL AND e.created_at >= cur.s AND e.created_at < cur.e GROUP BY a.agent_user_id, e.id, e.created_at`,
    params
  )).rows;
  const mins = new Map<string, number[]>();
  for (const x of resp) { const m = Number(x["mins"]); if (m >= 0) mins.set(String(x["id"]), [...(mins.get(String(x["id"])) ?? []), m]); }
  const agents: AgentFact[] = agentRows.map(x => {
    const id = String(x["id"]), med = median(mins.get(id) ?? []);
    return { id, name: String(x["name"]), listings: Number(x["listings"]), enquiries: Number(x["enquiries"]), unanswered: Number(x["unanswered"]),
      offers: Number(x["offers"]), accepted: Number(x["accepted"]), decided: Number(x["decided"]), ...(med !== undefined ? { medianResponseMinutes: med } : {}) };
  });
  const { teams } = await loadTeamFacts(db, r, now);
  return { current, previous, areas: [...byArea.values()], agents, teams };
}
