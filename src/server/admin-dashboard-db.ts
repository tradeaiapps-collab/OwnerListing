import type { RawOverview, Windowed } from "../domain/admin-dashboard";
import type { Queryable } from "./db";

const n = (v: unknown) => Number(v ?? 0);
const pair = (r: Record<string, unknown> | undefined, cur: string, prev: string): Windowed => ({ current: n(r?.[cur]), previous: n(r?.[prev]) });

/**
 * Grouped counts and sums for the admin dashboard over the last `days` days and the `days` before that. No personal data is selected.
 * Offers are dated by submission; an accepted offer counts in the window it was submitted in.
 */
export async function loadOverview(db: Queryable, days: number): Promise<RawOverview> {
  const span = `${Math.max(1, Math.trunc(days))} days`;
  const [listings, newListings, offers, revenue, users, newUsers, ops] = await Promise.all([
    db.query(`SELECT status AS key, count(*)::int AS n FROM property_listing GROUP BY status ORDER BY status`),
    db.query(`SELECT count(*) FILTER (WHERE created_at >= now() - $1::interval)::int AS cur,
                     count(*) FILTER (WHERE created_at < now() - $1::interval AND created_at >= now() - 2 * $1::interval)::int AS prev
                FROM property_listing`, [span]),
    db.query(`SELECT count(*) FILTER (WHERE submitted_at >= now() - $1::interval)::int AS sub_cur,
                     count(*) FILTER (WHERE submitted_at < now() - $1::interval AND submitted_at >= now() - 2 * $1::interval)::int AS sub_prev,
                     count(*) FILTER (WHERE status = 'accepted' AND submitted_at >= now() - $1::interval)::int AS acc_cur,
                     count(*) FILTER (WHERE status = 'accepted' AND submitted_at < now() - $1::interval AND submitted_at >= now() - 2 * $1::interval)::int AS acc_prev
                FROM formal_offer`, [span]),
    db.query(`SELECT COALESCE(sum(total_cents) FILTER (WHERE paid_at >= now() - $1::interval), 0)::text AS cur,
                     COALESCE(sum(total_cents) FILTER (WHERE paid_at < now() - $1::interval AND paid_at >= now() - 2 * $1::interval), 0)::text AS prev
                FROM invoice WHERE status = 'paid'`, [span]),
    db.query(`SELECT user_type AS key, count(*)::int AS n FROM app_user WHERE status <> 'closed' GROUP BY user_type ORDER BY user_type`),
    db.query(`SELECT count(*) FILTER (WHERE created_at >= now() - $1::interval)::int AS cur,
                     count(*) FILTER (WHERE created_at < now() - $1::interval AND created_at >= now() - 2 * $1::interval)::int AS prev,
                     count(*) FILTER (WHERE status = 'suspended')::int AS suspended
                FROM app_user WHERE user_type <> 'admin'`, [span]),
    db.query(`SELECT (SELECT count(*) FROM admin_case WHERE status <> 'resolved')::int AS cases,
                     (SELECT count(*) FROM id_submission WHERE status = 'pending')::int AS ids`)
  ]);
  const counted = (rows: Record<string, unknown>[]) => rows.map(r => ({ key: String(r["key"]), count: n(r["n"]) }));
  const o = offers.rows[0], u = newUsers.rows[0], x = ops.rows[0];
  return {
    listingsByStatus: counted(listings.rows),
    newListings: pair(newListings.rows[0], "cur", "prev"),
    offersSubmitted: pair(o, "sub_cur", "sub_prev"),
    offersAccepted: pair(o, "acc_cur", "acc_prev"),
    revenueCents: pair(revenue.rows[0], "cur", "prev"),
    usersByType: counted(users.rows),
    newUsers: pair(u, "cur", "prev"),
    suspendedUsers: n(u?.["suspended"]),
    openCases: n(x?.["cases"]),
    idPending: n(x?.["ids"])
  };
}
