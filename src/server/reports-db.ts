import type { OwnerListingRow, RawStaffReport } from "../domain/reports";
import type { Queryable } from "./db";

const n = (v: unknown) => Number(v ?? 0);
const counted = (rows: Record<string, unknown>[]) => rows.map(r => ({ key: String(r["key"]), count: n(r["n"]) }));

/** Grouped counts and sums for the staff report. No personal data and no account numbers are selected. */
export async function loadStaffReport(db: Queryable): Promise<RawStaffReport> {
  const [listings, paid, cases, buyers, ids, trust] = await Promise.all([
    db.query(`SELECT status AS key, count(*)::int AS n FROM property_listing GROUP BY status`),
    db.query(`SELECT count(*)::int AS n, COALESCE(sum(total_cents), 0)::text AS total, COALESCE(sum(gst_cents), 0)::text AS gst,
                     COALESCE(sum(total_cents) FILTER (WHERE paid_at >= now() - interval '30 days'), 0)::text AS last30
                FROM invoice WHERE status = 'paid'`),
    db.query(`SELECT kind, status, count(*)::int AS n FROM admin_case WHERE status <> 'resolved' GROUP BY kind, status`),
    db.query(`SELECT (SELECT count(*) FROM app_user WHERE user_type = 'buyer')::int AS accounts,
                     count(*) FILTER (WHERE email_verified_at IS NOT NULL)::int AS email, count(*) FILTER (WHERE phone_verified_at IS NOT NULL)::int AS phone,
                     count(*) FILTER (WHERE id_verified_at IS NOT NULL)::int AS id FROM buyer_verification`),
    db.query(`SELECT status AS key, count(*)::int AS n FROM id_submission GROUP BY status`),
    db.query(`SELECT c.decision AS key, count(*)::int AS n FROM trust_account_check c
               WHERE NOT EXISTS (SELECT 1 FROM trust_account_check x WHERE x.trust_account_id = c.trust_account_id AND x.listing_id = c.listing_id
                                   AND (x.checked_at, x.id) > (c.checked_at, c.id)) GROUP BY c.decision`)
  ]);
  const p = paid.rows[0] ?? {}, b = buyers.rows[0] ?? {};
  return {
    listingsByStatus: counted(listings.rows),
    paidInvoices: { count: n(p["n"]), totalCents: n(p["total"]), gstCents: n(p["gst"]), last30DaysCents: n(p["last30"]) },
    openCases: cases.rows.map(r => ({ kind: String(r["kind"]), status: String(r["status"]), count: n(r["n"]) })),
    buyers: { accounts: n(b["accounts"]), emailVerified: n(b["email"]), phoneVerified: n(b["phone"]), idVerified: n(b["id"]) },
    idSubmissions: counted(ids.rows),
    trustChecks: counted(trust.rows)
  };
}

/** Only listings owned by ownerId; the id comes from the session. listingId narrows to one listing (empty result when it is not theirs). */
export async function loadOwnerReport(db: Queryable, ownerId: string, listingId?: string): Promise<OwnerListingRow[]> {
  const res = await db.query(
    `SELECT l.id, l.title, l.status,
            (SELECT count(*)::int FROM enquiry e WHERE e.listing_id = l.id) AS enquiries,
            (SELECT count(*)::int FROM formal_offer o WHERE o.listing_id = l.id) AS offers
       FROM property_listing l WHERE l.owner_user_id = $1 AND ($2::uuid IS NULL OR l.id = $2::uuid) ORDER BY l.created_at DESC LIMIT 200`,
    [ownerId, listingId ?? null]
  );
  return res.rows.map(r => ({ id: String(r["id"]), title: String(r["title"]), status: String(r["status"]), enquiries: n(r["enquiries"]), offers: n(r["offers"]) }));
}
