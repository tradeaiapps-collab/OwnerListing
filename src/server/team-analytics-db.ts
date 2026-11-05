import { ANALYTICS_TIME_ZONE, bucketKeys, type Range } from "../domain/admin-analytics";
import type { ReportFacts } from "../domain/agent-reports";
import type { CommissionAgg, TeamAnalyticsDeps } from "../domain/team-analytics";
import type { TeamCounts, TeamFact, TeamSeriesFact } from "../domain/team-compare";
import { createPgAgencyTeamRepository } from "./agency-team-db";
import { offerFactsPg } from "./agent-reports-db";
import { leadsPg } from "./agent-workspace-db";
import { getDb } from "./context";
import type { Queryable } from "./db";

// Constant SQL; ids, dates and the zone only travel as bound parameters. Team ids are checked against the caller's manager role by the
// domain before any team query runs. Grouped counts and sums only; no buyer or owner data.

/** Params: 1 team, 2 from, 3 to, 4 zone. Commission recorded in the period, by agent. */
export const TEAM_COMMISSION_SQL =
  "SELECT member_user_id, COALESCE(sum(gross_cents), 0) AS gross, COALESCE(sum(member_cents), 0) AS member, COALESCE(sum(office_cents), 0) AS office, count(*) AS entries " +
  "FROM agency_commission WHERE team_id = $1::uuid AND created_at >= ($2::date)::timestamp AT TIME ZONE $4 AND created_at < ($3::date + 1)::timestamp AT TIME ZONE $4 GROUP BY member_user_id";
/** Params: 1 agent ids. Distinct listings the agents are appointed to now (a listing two agents share counts once). */
export const LISTED_NOW_SQL = "SELECT count(DISTINCT listing_id) AS n FROM listing_agent_appointment WHERE agent_user_id = ANY($1::uuid[]) AND revoked_at IS NULL";

export function createTeamAnalyticsDeps(db: Queryable, now: () => Date = () => new Date()): TeamAnalyticsDeps {
  const repo = createPgAgencyTeamRepository(db);
  return {
    repo, now,
    async facts(userIds) {
      const out = new Map<string, ReportFacts>();
      for (const id of userIds) out.set(id, { leads: await leadsPg(db, id), offers: await offerFactsPg(db, id) });
      return out;
    },
    dashboardRows: (teamId, at) => repo.dashboardRows(teamId, at),
    async commissions(teamId, from, to) {
      const { rows } = await db.query(TEAM_COMMISSION_SQL, [teamId, from, to, ANALYTICS_TIME_ZONE]);
      return rows.map((r): CommissionAgg => ({ memberUserId: String(r["member_user_id"]), grossCents: Number(r["gross"]), memberCents: Number(r["member"]), officeCents: Number(r["office"]), entries: Number(r["entries"]) }));
    },
    async listedNow(userIds) {
      if (userIds.length === 0) return 0;
      return Number((await db.query(LISTED_NOW_SQL, [userIds])).rows[0]?.["n"] ?? 0);
    }
  };
}
export const getTeamAnalyticsDeps = () => createTeamAnalyticsDeps(getDb());

const UNIT: Record<Range["bucket"], string> = { day: "day", week: "week", month: "month" };
// Listings each team holds now: every listing one of its members is appointed to, once per team.
const TEAM_LISTINGS =
  "tl AS (SELECT DISTINCT m.team_id, a.listing_id FROM agency_team_member m JOIN listing_agent_appointment a ON a.agent_user_id = m.user_id AND a.revoked_at IS NULL WHERE m.removed_at IS NULL)";

/**
 * Every team's counts for the chosen period and the equal period before it, plus accepted offers per team per bucket. Periods are whole
 * calendar days in the reporting zone. Offers are dated by submission, commission by the day it was recorded. Teams with no members left
 * are still listed (zeros) so a team that went quiet does not vanish from the comparison.
 */
export async function loadTeamFacts(db: Queryable, r: Range, now: Date = new Date()): Promise<{ teams: TeamFact[]; series: { buckets: string[]; bucket: Range["bucket"]; rows: TeamSeriesFact[] } }> {
  const params = [r.from, r.to, ANALYTICS_TIME_ZONE];
  const teams = (await db.query(
    `WITH ${TEAM_LISTINGS},
     w AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS cs, ($2::date + 1)::timestamp AT TIME ZONE $3 AS ce,
                  ($1::date - ($2::date - $1::date + 1))::timestamp AT TIME ZONE $3 AS ps)
     SELECT t.id, t.name, t.kind,
            (SELECT count(*) FROM agency_team_member m WHERE m.team_id = t.id AND m.removed_at IS NULL) AS members,
            (SELECT count(*) FROM tl WHERE tl.team_id = t.id) AS listings,
            (SELECT count(*) FROM agency_task k WHERE k.team_id = t.id AND k.status <> 'done' AND k.due_date < ($4::timestamptz AT TIME ZONE 'UTC')::date) AS overdue,
            enq.cur AS enq_cur, enq.prev AS enq_prev, off.cur AS off_cur, off.prev AS off_prev,
            off.acc_cur, off.acc_prev, off.cents_cur, off.cents_prev, com.cur AS com_cur, com.prev AS com_prev
       FROM agency_team t CROSS JOIN w
       LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE e.created_at >= w.cs AND e.created_at < w.ce) AS cur,
                                 count(*) FILTER (WHERE e.created_at >= w.ps AND e.created_at < w.cs) AS prev
                            FROM tl JOIN enquiry e ON e.listing_id = tl.listing_id
                           WHERE tl.team_id = t.id AND e.created_at >= w.ps AND e.created_at < w.ce) enq ON true
       LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE o.submitted_at >= w.cs AND o.submitted_at < w.ce) AS cur,
                                 count(*) FILTER (WHERE o.submitted_at >= w.ps AND o.submitted_at < w.cs) AS prev,
                                 count(*) FILTER (WHERE o.status = 'accepted' AND o.submitted_at >= w.cs AND o.submitted_at < w.ce) AS acc_cur,
                                 count(*) FILTER (WHERE o.status = 'accepted' AND o.submitted_at >= w.ps AND o.submitted_at < w.cs) AS acc_prev,
                                 COALESCE(sum(o.price_cents) FILTER (WHERE o.status = 'accepted' AND o.submitted_at >= w.cs AND o.submitted_at < w.ce), 0) AS cents_cur,
                                 COALESCE(sum(o.price_cents) FILTER (WHERE o.status = 'accepted' AND o.submitted_at >= w.ps AND o.submitted_at < w.cs), 0) AS cents_prev
                            FROM tl JOIN formal_offer o ON o.listing_id = tl.listing_id
                           WHERE tl.team_id = t.id AND o.submitted_at >= w.ps AND o.submitted_at < w.ce) off ON true
       LEFT JOIN LATERAL (SELECT COALESCE(sum(c.gross_cents) FILTER (WHERE c.created_at >= w.cs AND c.created_at < w.ce), 0) AS cur,
                                 COALESCE(sum(c.gross_cents) FILTER (WHERE c.created_at >= w.ps AND c.created_at < w.cs), 0) AS prev
                            FROM agency_commission c WHERE c.team_id = t.id AND c.created_at >= w.ps AND c.created_at < w.ce) com ON true
      ORDER BY t.name, t.id LIMIT 500`,
    [...params, now.toISOString()]
  )).rows;

  const n = (v: unknown) => Number(v ?? 0);
  const counts = (x: Record<string, unknown>, w: "cur" | "prev"): TeamCounts => ({
    enquiries: n(x[`enq_${w}`]), offers: n(x[`off_${w}`]), accepted: n(x[`acc_${w}`]), acceptedCents: n(x[`cents_${w}`]), commissionCents: n(x[`com_${w}`])
  });
  const facts: TeamFact[] = teams.map(x => ({
    id: String(x["id"]), name: String(x["name"]), kind: String(x["kind"]), members: n(x["members"]), activeListings: n(x["listings"]), overdueTasks: n(x["overdue"]),
    current: counts(x, "cur"), previous: counts(x, "prev")
  }));

  const unit = UNIT[r.bucket];
  const rows = (await db.query(
    `WITH ${TEAM_LISTINGS}
     SELECT tl.team_id, to_char(date_trunc('${unit}', o.submitted_at AT TIME ZONE $3), 'YYYY-MM-DD') AS bucket, count(*) AS accepted, COALESCE(sum(o.price_cents), 0) AS cents
       FROM tl JOIN formal_offer o ON o.listing_id = tl.listing_id
      WHERE o.status = 'accepted' AND o.submitted_at >= ($1::date)::timestamp AT TIME ZONE $3 AND o.submitted_at < ($2::date + 1)::timestamp AT TIME ZONE $3
      GROUP BY 1, 2`,
    params
  )).rows.map((x): TeamSeriesFact => ({ teamId: String(x["team_id"]), bucket: String(x["bucket"]), accepted: n(x["accepted"]), cents: n(x["cents"]) }));
  return { teams: facts, series: { buckets: bucketKeys(r), bucket: r.bucket, rows } };
}
