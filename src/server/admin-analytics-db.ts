import { ANALYTICS_TIME_ZONE, type MetricRow, type Range } from "../domain/admin-analytics";
import type { Queryable } from "./db";

const UNIT: Record<Range["bucket"], string> = { day: "day", week: "week", month: "month" };

/**
 * Per-bucket counts and sums for the analytics screen. `from`..`to` are whole calendar days in the reporting zone. Listings published
 * are read from the audit log (the listing row keeps no publish time). Offers are dated by submission, revenue by payment.
 * Grouped counts only: no personal data is selected.
 */
export async function loadAnalytics(db: Queryable, r: Range): Promise<MetricRow[]> {
  const unit = UNIT[r.bucket];
  const b = (col: string) => `to_char(date_trunc('${unit}', ${col} AT TIME ZONE $3), 'YYYY-MM-DD')`;
  const within = (col: string) => `${col} >= ($1::date)::timestamp AT TIME ZONE $3 AND ${col} < ($2::date + 1)::timestamp AT TIME ZONE $3`;
  const res = await db.query(
    `SELECT 'listings_created' AS metric, ${b("created_at")} AS bucket, count(*)::bigint AS value
       FROM property_listing WHERE ${within("created_at")} GROUP BY 2
     UNION ALL
     SELECT 'listings_published', ${b("occurred_at")}, count(DISTINCT aggregate_id)
       FROM audit_event WHERE aggregate_type = 'listing' AND event_type = 'listing.published' AND ${within("occurred_at")} GROUP BY 2
     UNION ALL
     SELECT 'offers_submitted', ${b("submitted_at")}, count(*) FROM formal_offer WHERE ${within("submitted_at")} GROUP BY 2
     UNION ALL
     SELECT 'offers_accepted', ${b("submitted_at")}, count(*) FROM formal_offer WHERE status = 'accepted' AND ${within("submitted_at")} GROUP BY 2
     UNION ALL
     SELECT 'revenue_cents', ${b("paid_at")}, COALESCE(sum(total_cents), 0) FROM invoice WHERE status = 'paid' AND ${within("paid_at")} GROUP BY 2
     UNION ALL
     SELECT CASE WHEN user_type IN ('owner', 'agent', 'buyer') THEN 'signups_' || user_type ELSE 'signups_other' END, ${b("created_at")}, count(*)
       FROM app_user WHERE user_type <> 'admin' AND ${within("created_at")} GROUP BY 1, 2`,
    [r.from, r.to, ANALYTICS_TIME_ZONE]
  );
  return res.rows.map(x => ({ metric: String(x["metric"]), bucket: String(x["bucket"]), value: Number(x["value"] ?? 0) }));
}
