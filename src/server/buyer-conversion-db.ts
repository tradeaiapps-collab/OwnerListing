import { OUTCOME_WINDOW_DAYS, type Bucket, type BuyerFacts, type ConversionDeps, type ConversionScore, type Resolved } from "../domain/buyer-conversion";
import { getDb } from "./context";
import { verifiedLicencesPg, type Queryable } from "./db";

// Constant SQL; ids only travel as bound parameters. Scoped to listings the agent is actively appointed to.
const iso = (v: unknown): string | undefined => (v == null ? undefined : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const n = (v: unknown) => Number(v ?? 0);

export async function buyerFactsPg(db: Queryable, agentId: string): Promise<BuyerFacts[]> {
  const r = await db.query(
    `SELECT e.id AS enquiry_id, l.id AS listing_id, l.title, l.price_cents, u.id AS buyer_id, u.display_name, e.created_at,
            (SELECT count(*) FROM listing_view v WHERE v.listing_id = l.id AND v.viewer_user_id = e.buyer_user_id) AS views,
            (SELECT max(v.viewed_at) FROM listing_view v WHERE v.listing_id = l.id AND v.viewer_user_id = e.buyer_user_id) AS last_view,
            EXISTS (SELECT 1 FROM saved_listing sl WHERE sl.listing_id = l.id AND sl.buyer_user_id = e.buyer_user_id) AS saved,
            (SELECT count(*) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = e.buyer_user_id) AS buyer_msgs,
            (SELECT count(*) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = $1::uuid) AS agent_msgs,
            (SELECT max(m.sent_at) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = e.buyer_user_id) AS last_buyer_at,
            (SELECT max(m.sent_at) FROM enquiry_message m WHERE m.enquiry_id = e.id AND m.sender_user_id = $1::uuid) AS last_agent_at,
            vb.requested AS vb_requested, vb.confirmed AS vb_confirmed, vb.cancelled AS vb_cancelled, vb.last_start AS vb_last,
            ib.requested AS ib_requested, ib.scheduled AS ib_scheduled, ib.cancelled AS ib_cancelled,
            o.offers, o.status AS offer_status, o.price_cents AS offer_cents, o.last_at AS offer_at,
            (SELECT count(*) FROM offer_counter oc JOIN formal_offer fo ON fo.id = oc.offer_id
              WHERE fo.listing_id = l.id AND fo.buyer_user_id = e.buyer_user_id) AS counter_rounds,
            bv.id_verified_at IS NOT NULL AS id_verified,
            (SELECT count(*) FROM enquiry e2 WHERE e2.buyer_user_id = e.buyer_user_id AND e2.listing_id <> l.id) AS other_enquiries,
            (SELECT count(*) FROM formal_offer fo2 WHERE fo2.buyer_user_id = e.buyer_user_id AND fo2.listing_id <> l.id) AS prior_offers,
            s.stage, to_char(s.follow_up_at, 'YYYY-MM-DD') AS follow_up_at
       FROM listing_agent_appointment a
       JOIN property_listing l ON l.id = a.listing_id
       JOIN enquiry e ON e.listing_id = l.id
       JOIN app_user u ON u.id = e.buyer_user_id
       LEFT JOIN buyer_verification bv ON bv.user_id = e.buyer_user_id
       LEFT JOIN agent_lead_state s ON s.agent_user_id = $1::uuid AND s.enquiry_id = e.id
       LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE kind = 'viewing' AND status IN ('requested','confirmed')) AS requested,
                                 count(*) FILTER (WHERE kind = 'viewing' AND status = 'confirmed') AS confirmed,
                                 count(*) FILTER (WHERE kind = 'viewing' AND status = 'cancelled') AS cancelled,
                                 max(starts_at) FILTER (WHERE kind = 'viewing' AND status = 'confirmed') AS last_start
                            FROM viewing_booking b WHERE b.listing_id = l.id AND b.requester_user_id = e.buyer_user_id) vb ON true
       LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE status <> 'cancelled') AS requested,
                                 count(*) FILTER (WHERE status = 'scheduled') AS scheduled,
                                 count(*) FILTER (WHERE status = 'cancelled') AS cancelled
                            FROM inspection_booking b WHERE b.listing_id = l.id AND b.buyer_id = e.buyer_user_id) ib ON true
       LEFT JOIN LATERAL (SELECT (SELECT count(*) FROM formal_offer WHERE listing_id = l.id AND buyer_user_id = e.buyer_user_id) AS offers,
                                 x.status, x.price_cents, x.submitted_at AS last_at
                            FROM (SELECT 1) one
                            LEFT JOIN LATERAL (SELECT status, price_cents, submitted_at FROM formal_offer
                                                WHERE listing_id = l.id AND buyer_user_id = e.buyer_user_id ORDER BY submitted_at DESC LIMIT 1) x ON true) o ON true
      WHERE a.agent_user_id = $1::uuid AND a.revoked_at IS NULL
      ORDER BY e.created_at DESC, e.id LIMIT 500`,
    [agentId]
  );
  return r.rows.map((x): BuyerFacts => {
    const lastActivity = [x["created_at"], x["last_view"], x["last_buyer_at"], x["offer_at"]].map(iso).filter((v): v is string => !!v).sort().pop();
    return {
      enquiryId: String(x["enquiry_id"]), listingId: String(x["listing_id"]), listingTitle: String(x["title"]), buyerId: String(x["buyer_id"]),
      buyerName: String(x["display_name"]), enquiredAt: iso(x["created_at"])!,
      ...(x["price_cents"] != null ? { listingPriceCents: n(x["price_cents"]) } : {}),
      views: n(x["views"]), saved: x["saved"] === true,
      buyerMessages: n(x["buyer_msgs"]), agentMessages: n(x["agent_msgs"]),
      ...(iso(x["last_buyer_at"]) ? { lastBuyerMessageAt: iso(x["last_buyer_at"])! } : {}),
      ...(iso(x["last_agent_at"]) ? { lastAgentContactAt: iso(x["last_agent_at"])! } : {}),
      viewingsRequested: n(x["vb_requested"]), viewingsConfirmed: n(x["vb_confirmed"]), viewingsCancelled: n(x["vb_cancelled"]),
      ...(iso(x["vb_last"]) ? { lastViewingAt: iso(x["vb_last"])! } : {}),
      inspectionsRequested: n(x["ib_requested"]), inspectionsScheduled: n(x["ib_scheduled"]), inspectionsCancelled: n(x["ib_cancelled"]),
      offers: n(x["offers"]), counterRounds: n(x["counter_rounds"]),
      ...(x["offer_status"] ? { latestOfferStatus: String(x["offer_status"]), latestOfferCents: n(x["offer_cents"]) } : {}),
      idVerified: x["id_verified"] === true,
      otherEnquiries: n(x["other_enquiries"]), priorOffersElsewhere: n(x["prior_offers"]),
      ...(lastActivity ? { lastActivityAt: lastActivity } : {}),
      ...(x["stage"] ? { stage: String(x["stage"]) } : {}), ...(x["follow_up_at"] ? { followUpAt: String(x["follow_up_at"]) } : {})
    };
  });
}

/** Marks snapshots whose buyer made an offer after the snapshot (within the window) as converted. Offers only move a snapshot forward: offer, then accepted. */
export async function resolveOutcomesPg(db: Queryable, agentId: string): Promise<void> {
  await db.query(
    `UPDATE buyer_lead_score s SET outcome = 'offer', outcome_at = x.at
       FROM (SELECT s2.agent_user_id, s2.enquiry_id, s2.snap_date, min(fo.submitted_at) AS at
               FROM buyer_lead_score s2 JOIN enquiry e ON e.id = s2.enquiry_id
               JOIN formal_offer fo ON fo.listing_id = e.listing_id AND fo.buyer_user_id = e.buyer_user_id
              WHERE s2.agent_user_id = $1::uuid AND s2.outcome IS NULL AND fo.submitted_at > s2.created_at
                AND fo.submitted_at <= s2.created_at + make_interval(days => $2::int)
              GROUP BY 1, 2, 3) x
      WHERE s.agent_user_id = x.agent_user_id AND s.enquiry_id = x.enquiry_id AND s.snap_date = x.snap_date`,
    [agentId, OUTCOME_WINDOW_DAYS]);
  await db.query(
    `UPDATE buyer_lead_score s SET outcome = 'accepted'
      WHERE s.agent_user_id = $1::uuid AND s.outcome = 'offer'
        AND EXISTS (SELECT 1 FROM enquiry e JOIN formal_offer fo ON fo.listing_id = e.listing_id AND fo.buyer_user_id = e.buyer_user_id
                     WHERE e.id = s.enquiry_id AND fo.status = 'accepted' AND fo.submitted_at >= s.outcome_at)`,
    [agentId]);
}

/** One row per lead per day. Leads that already have an offer are not snapshotted: the score would be a prediction of something that already happened. */
export async function snapshotPg(db: Queryable, agentId: string, rows: readonly ConversionScore[], day: string, offered: ReadonlySet<string>): Promise<void> {
  const fresh = rows.filter(r => !r.closed && !offered.has(r.enquiryId));
  if (fresh.length === 0) return;
  const v: unknown[] = [agentId, day];
  const values = fresh.map(r => { v.push(r.enquiryId, r.probability, r.modelProbability, r.tier, r.confidence, r.modelVersion); const o = v.length - 6; return `($1::uuid,$${o + 1}::uuid,$2::date,$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6})`; });
  await db.query(
    `INSERT INTO buyer_lead_score (agent_user_id, enquiry_id, snap_date, probability, model_probability, tier, confidence, model_version)
     VALUES ${values.join(",")} ON CONFLICT (agent_user_id, enquiry_id, snap_date) DO NOTHING`, v);
}

/** Resolved snapshots platform-wide (no ids leave this function): converted ones, plus unconverted ones older than the window. */
export async function resolvedPg(db: Queryable): Promise<Resolved[]> {
  const r = await db.query(
    `SELECT probability, outcome IS NOT NULL AS converted FROM buyer_lead_score
      WHERE outcome IS NOT NULL OR created_at < now() - make_interval(days => $1::int)`, [OUTCOME_WINDOW_DAYS]);
  return r.rows.map(x => ({ probability: n(x["probability"]), converted: x["converted"] === true }));
}

/** Calibration uses the model's own number, so a band's history is not skewed by earlier calibration. */
export async function bucketsPg(db: Queryable): Promise<Bucket[]> {
  const r = await db.query(
    `SELECT least(90, (model_probability / 10) * 10) AS lo, count(*) AS n, count(*) FILTER (WHERE outcome IS NOT NULL) AS converted
       FROM buyer_lead_score WHERE outcome IS NOT NULL OR created_at < now() - make_interval(days => $1::int) GROUP BY 1`, [OUTCOME_WINDOW_DAYS]);
  return r.rows.map(x => ({ lo: n(x["lo"]), n: n(x["n"]), converted: n(x["converted"]) }));
}

export function createConversionDeps(db: Queryable, now: () => Date = () => new Date()): ConversionDeps {
  const offered = new Map<string, ReadonlySet<string>>();
  return {
    licences: () => verifiedLicencesPg(db), today: () => now().toISOString().slice(0, 10), now,
    async facts(agentId) {
      await resolveOutcomesPg(db, agentId);
      const f = await buyerFactsPg(db, agentId);
      offered.set(agentId, new Set(f.filter(x => x.offers > 0).map(x => x.enquiryId)));
      return f;
    },
    buckets: () => bucketsPg(db),
    snapshot: (agentId, rows, day) => snapshotPg(db, agentId, rows, day, offered.get(agentId) ?? new Set()),
    accuracy: () => resolvedPg(db)
  };
}
export const getConversionDeps = (): ConversionDeps => createConversionDeps(getDb());
