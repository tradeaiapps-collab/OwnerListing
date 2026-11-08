import { randomUUID } from "node:crypto";
import { maskName } from "../domain/admin-report-builder";
import {
  assess, effectiveStatus, PREQUAL_ENGINE, sellerView, STATUS_LABEL,
  type Assessment, type ConditionCode, type Confidence, type Extracted, type PrequalRow, type PrequalStatus, type RedFlag, type ReviewInput, type SellerPrequalView
} from "../domain/prequalification";
import { appendAuditPg, type Queryable } from "./db";

// Constant SQL text; user input only travels as bound parameters. Every write and its audit_event row run in one transaction.
// Nothing here deletes a row. The storage key (document_url) is only ever returned by documentKeyFor, for the staff download route.

export interface StaffRef { id: string; role: string }
export type Out<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const no = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());
const isoReq = (v: unknown): string => iso(v) ?? new Date(0).toISOString();
const conds = (v: unknown): ConditionCode[] => (Array.isArray(v) ? (v as ConditionCode[]) : []);
const num = (v: unknown): number | null => (v == null ? null : Number(v));

async function audit(tx: Queryable, actorId: string, id: string, eventType: string, payload: Record<string, unknown>) {
  await appendAuditPg(tx, {
    id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId,
    aggregateType: "prequalification", aggregateId: id, eventType, correlationId: randomUUID(), payload
  });
}

const SUMMARY_JOIN =
  "LEFT JOIN LATERAL (SELECT confidence_level, elena_summary, red_flags, extracted_data FROM prequalification_summaries " +
  "WHERE prequalification_id = q.id ORDER BY created_at DESC LIMIT 1) s ON TRUE";

export interface NewPrequal {
  id: string; buyerId: string; listingId?: string | undefined; storageKey: string; sha256: string; sizeBytes: number;
  approvedCents?: number | undefined; ratePercent?: number | undefined; termYears?: number | undefined; conditions: readonly ConditionCode[];
  expiresAt?: string | undefined; shareWithSellers: boolean; extracted: Extracted | null; assessment: Assessment; now: string;
}

/** Stores a new pre-approval as pending review with Elena's first reading. */
export async function insertPrequal(db: Queryable, p: NewPrequal): Promise<void> {
  await atomic(db, async tx => {
    await tx.query(
      `INSERT INTO buyer_prequalifications (id, buyer_id, listing_id, document_url, sha256, size_bytes, approved_amount_cents, interest_rate, loan_term_years, conditions, expires_at, share_with_sellers, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz,$12,$13::timestamptz)`,
      [p.id, p.buyerId, p.listingId ?? null, p.storageKey, p.sha256, p.sizeBytes, p.approvedCents ?? null, p.ratePercent ?? null, p.termYears ?? null,
        JSON.stringify(p.conditions), p.expiresAt ?? null, p.shareWithSellers, p.now]
    );
    await tx.query(
      `INSERT INTO prequalification_summaries (prequalification_id, confidence_level, extracted_data, elena_summary, red_flags, engine, source)
       VALUES ($1,$2,$3::jsonb,$4,$5::jsonb,$6,'elena')`,
      [p.id, p.assessment.confidence, JSON.stringify(p.extracted ?? { conditions: [] }), p.assessment.summary, JSON.stringify(p.assessment.flags), PREQUAL_ENGINE]
    );
    await audit(tx, p.buyerId, p.id, "prequal.uploaded", { listingId: p.listingId ?? null, confidence: p.assessment.confidence });
  });
}

export async function countRecentUploads(db: Queryable, buyerId: string, sinceIso: string): Promise<number> {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM buyer_prequalifications WHERE buyer_id = $1::uuid AND created_at >= $2::timestamptz", [buyerId, sinceIso]);
  return Number(rows[0]?.["n"] ?? 0);
}

/** The listing's asking price when it is a published sale listing, so an upload tied to it can be compared with the price. */
export async function publishedListing(db: Queryable, listingId: string): Promise<{ priceCents: number | null } | undefined> {
  const { rows } = await db.query("SELECT price_cents FROM property_listing WHERE id = $1::uuid AND status = 'published' AND transaction_type = 'sale'", [listingId]);
  return rows[0] ? { priceCents: num(rows[0]["price_cents"]) } : undefined;
}

export interface BuyerPrequalView {
  id: string; status: PrequalStatus; label: string; listingTitle: string | null; approvedCents: number | null; expiresAt: string | null; createdAt: string;
  confidence: Confidence | null; summary: string | null; flags: string[]; note: string | null; sharedWithSellers: boolean;
}

/** The buyer's own pre-approvals, newest first. */
export async function listForBuyer(db: Queryable, buyerId: string, now: string): Promise<BuyerPrequalView[]> {
  const { rows } = await db.query(
    `SELECT q.id, q.status, l.title AS listing_title, q.approved_amount_cents, q.expires_at, q.created_at, q.review_note, q.share_with_sellers,
            s.confidence_level, s.elena_summary, s.red_flags
     FROM buyer_prequalifications q LEFT JOIN property_listing l ON l.id = q.listing_id ${SUMMARY_JOIN}
     WHERE q.buyer_id = $1::uuid ORDER BY q.created_at DESC LIMIT 50`, [buyerId]
  );
  return rows.map(r => {
    const status = effectiveStatus(String(r["status"]) as PrequalStatus, iso(r["expires_at"]), now);
    return {
      id: String(r["id"]), status, label: STATUS_LABEL[status], listingTitle: r["listing_title"] == null ? null : String(r["listing_title"]),
      approvedCents: num(r["approved_amount_cents"]), expiresAt: iso(r["expires_at"]), createdAt: isoReq(r["created_at"]),
      confidence: r["confidence_level"] == null ? null : (String(r["confidence_level"]) as Confidence), summary: r["elena_summary"] == null ? null : String(r["elena_summary"]),
      flags: ((r["red_flags"] as RedFlag[] | null) ?? []).map(f => f.text), note: r["review_note"] == null ? null : String(r["review_note"]),
      sharedWithSellers: Boolean(r["share_with_sellers"])
    };
  });
}

export interface OfferPrequal { offerId: string; priceCents: number; prequal: SellerPrequalView }

/**
 * Pre-approval status for each live offer on one listing. The caller has already checked that the user may handle the listing.
 * Per buyer it picks a current verified letter first, then one pending review; letters the buyer did not share are never read.
 * Buyer identity is not returned: the offers screen already identifies offers by id only.
 */
export async function prequalsForListing(db: Queryable, listingId: string, now: string): Promise<OfferPrequal[]> {
  const { rows } = await db.query(
    `SELECT o.id AS offer_id, o.price_cents, p.status, p.approved_amount_cents, p.conditions, p.expires_at, p.lender
     FROM formal_offer o
     LEFT JOIN LATERAL (
       SELECT q.status, q.approved_amount_cents, q.conditions, q.expires_at, s.extracted_data->>'lender' AS lender
       FROM buyer_prequalifications q ${SUMMARY_JOIN}
       WHERE q.buyer_id = o.buyer_user_id AND q.share_with_sellers AND q.status IN ('pending_review','verified','expired')
         AND (q.listing_id IS NULL OR q.listing_id = o.listing_id)
       ORDER BY (q.status = 'verified' AND q.expires_at > $2::timestamptz) DESC, (q.status = 'pending_review') DESC, q.created_at DESC LIMIT 1
     ) p ON TRUE
     WHERE o.listing_id = $1::uuid AND o.status <> 'withdrawn' ORDER BY o.submitted_at DESC LIMIT 200`, [listingId, now]
  );
  return rows.map(r => {
    const row: PrequalRow | undefined = r["status"] == null ? undefined : {
      status: String(r["status"]) as PrequalStatus, approvedCents: num(r["approved_amount_cents"]), conditions: conds(r["conditions"]),
      expiresAt: iso(r["expires_at"]), lender: r["lender"] == null ? undefined : String(r["lender"])
    };
    const priceCents = Number(r["price_cents"]);
    return { offerId: String(r["offer_id"]), priceCents, prequal: sellerView(row, priceCents, now) };
  });
}

export interface QueueRow {
  id: string; buyerName: string; listingTitle: string | null; approvedCents: number | null; status: PrequalStatus; label: string; confidence: Confidence | null;
  summary: string | null; uploadedAt: string; expiresAt: string | null; percentOfPrice: number | null; unqualified: boolean;
}
export interface NoPrequalRow { offerId: string; listingTitle: string; priceCents: number; buyerName: string; submittedAt: string }

/** Staff queue. Buyer names are masked (first name and initial). `status` filters on what people see, so an expired approval shows under "expired". */
export async function staffQueue(db: Queryable, status: PrequalStatus | undefined, now: string): Promise<{ rows: QueueRow[]; noPrequal: NoPrequalRow[] }> {
  const { rows } = await db.query(
    `SELECT q.id, u.display_name, l.title AS listing_title, l.price_cents AS listing_price, q.approved_amount_cents, q.status, q.expires_at, q.created_at,
            s.confidence_level, s.elena_summary
     FROM buyer_prequalifications q JOIN app_user u ON u.id = q.buyer_id LEFT JOIN property_listing l ON l.id = q.listing_id ${SUMMARY_JOIN}
     ORDER BY (q.status = 'pending_review') DESC, q.created_at DESC LIMIT 500`, []
  );
  const mapped = rows.map(r => {
    const st = effectiveStatus(String(r["status"]) as PrequalStatus, iso(r["expires_at"]), now);
    const approved = num(r["approved_amount_cents"]), price = num(r["listing_price"]);
    const pct = approved !== null && price ? Math.round((approved / price) * 100) : null;
    return {
      id: String(r["id"]), buyerName: maskName(String(r["display_name"])), listingTitle: r["listing_title"] == null ? null : String(r["listing_title"]),
      approvedCents: approved, status: st, label: STATUS_LABEL[st], confidence: r["confidence_level"] == null ? null : (String(r["confidence_level"]) as Confidence),
      summary: r["elena_summary"] == null ? null : String(r["elena_summary"]), uploadedAt: isoReq(r["created_at"]), expiresAt: iso(r["expires_at"]),
      percentOfPrice: pct, unqualified: st === "expired" || st === "resubmit_requested" || (pct !== null && pct < 90)
    } satisfies QueueRow;
  });
  const none = await db.query(
    `SELECT o.id AS offer_id, l.title, o.price_cents, u.display_name, o.submitted_at
     FROM formal_offer o JOIN property_listing l ON l.id = o.listing_id JOIN app_user u ON u.id = o.buyer_user_id
     WHERE o.status IN ('submitted','under_review','countered')
       AND NOT EXISTS (SELECT 1 FROM buyer_prequalifications q WHERE q.buyer_id = o.buyer_user_id AND q.status IN ('pending_review','verified') AND (q.listing_id IS NULL OR q.listing_id = o.listing_id))
     ORDER BY o.submitted_at DESC LIMIT 100`, []
  );
  return {
    rows: status ? mapped.filter(r => r.status === status) : mapped,
    noPrequal: none.rows.map(r => ({ offerId: String(r["offer_id"]), listingTitle: String(r["title"]), priceCents: Number(r["price_cents"]), buyerName: maskName(String(r["display_name"])), submittedAt: isoReq(r["submitted_at"]) }))
  };
}

export interface StaffDetail {
  id: string; buyerName: string; listingTitle: string | null; listingPriceCents: number | null; highestOfferCents: number | null; status: PrequalStatus; label: string;
  approvedCents: number | null; ratePercent: number | null; termYears: number | null; conditions: ConditionCode[]; expiresAt: string | null; uploadedAt: string;
  shareWithSellers: boolean; note: string | null; verifiedAt: string | null;
  elena: { confidence: Confidence; summary: string; flags: RedFlag[]; extracted: Extracted } | null;
}

export async function staffDetail(db: Queryable, id: string, now: string): Promise<StaffDetail | undefined> {
  const { rows } = await db.query(
    `SELECT q.id, u.display_name, l.title AS listing_title, l.price_cents AS listing_price, q.status, q.approved_amount_cents, q.interest_rate, q.loan_term_years,
            q.conditions, q.expires_at, q.created_at, q.share_with_sellers, q.review_note, q.verified_at,
            s.confidence_level, s.elena_summary, s.red_flags, s.extracted_data,
            (SELECT max(o.price_cents) FROM formal_offer o WHERE o.buyer_user_id = q.buyer_id AND (q.listing_id IS NULL OR o.listing_id = q.listing_id) AND o.status <> 'withdrawn') AS highest_offer
     FROM buyer_prequalifications q JOIN app_user u ON u.id = q.buyer_id LEFT JOIN property_listing l ON l.id = q.listing_id ${SUMMARY_JOIN}
     WHERE q.id = $1::uuid`, [id]
  );
  const r = rows[0];
  if (!r) return undefined;
  const st = effectiveStatus(String(r["status"]) as PrequalStatus, iso(r["expires_at"]), now);
  return {
    id: String(r["id"]), buyerName: maskName(String(r["display_name"])), listingTitle: r["listing_title"] == null ? null : String(r["listing_title"]),
    listingPriceCents: num(r["listing_price"]), highestOfferCents: num(r["highest_offer"]), status: st, label: STATUS_LABEL[st],
    approvedCents: num(r["approved_amount_cents"]), ratePercent: num(r["interest_rate"]), termYears: num(r["loan_term_years"]), conditions: conds(r["conditions"]),
    expiresAt: iso(r["expires_at"]), uploadedAt: isoReq(r["created_at"]), shareWithSellers: Boolean(r["share_with_sellers"]),
    note: r["review_note"] == null ? null : String(r["review_note"]), verifiedAt: iso(r["verified_at"]),
    elena: r["confidence_level"] == null ? null : {
      confidence: String(r["confidence_level"]) as Confidence, summary: String(r["elena_summary"]),
      flags: (r["red_flags"] as RedFlag[] | null) ?? [], extracted: (r["extracted_data"] as Extracted | null) ?? { conditions: [] }
    }
  };
}

export async function documentKeyFor(db: Queryable, id: string): Promise<string | undefined> {
  const { rows } = await db.query("SELECT document_url FROM buyer_prequalifications WHERE id = $1::uuid", [id]);
  return rows[0] ? String(rows[0]["document_url"]) : undefined;
}

/**
 * Staff decision on a pending pre-approval. Only a pending one can be decided (checked in the UPDATE itself, so two staff members
 * cannot both act). Verifying stores the confirmed figures and adds a newer Elena summary computed from them.
 */
export async function reviewPrequal(db: Queryable, staff: StaffRef, id: string, input: ReviewInput, now: string): Promise<Out<{ status: PrequalStatus }>> {
  return atomic(db, async tx => {
    if (input.action === "resubmit") {
      const r = await tx.query(
        "UPDATE buyer_prequalifications SET status = 'resubmit_requested', review_note = $2, verified_by = NULL, verified_at = NULL WHERE id = $1::uuid AND status = 'pending_review' RETURNING id",
        [id, input.note ?? null]
      );
      if (!r.rows[0]) return no(409, "This pre-approval is not waiting for review.");
      await audit(tx, staff.id, id, "prequal.resubmit_requested", { role: staff.role });
      return { ok: true as const, value: { status: "resubmit_requested" as PrequalStatus } };
    }
    const r = await tx.query(
      `UPDATE buyer_prequalifications SET status = 'verified', approved_amount_cents = $2, interest_rate = $3, loan_term_years = $4, conditions = $5::jsonb,
         expires_at = (($6::date)::timestamp + interval '23 hours 59 minutes 59 seconds') AT TIME ZONE 'UTC', verified_by = $7::uuid, verified_at = $8::timestamptz, review_note = $9
       WHERE id = $1::uuid AND status = 'pending_review' RETURNING listing_id`,
      [id, input.approvedCents, input.ratePercent ?? null, input.termYears ?? null, JSON.stringify(input.conditions), input.expiresOn, staff.id, now, input.note ?? null]
    );
    if (!r.rows[0]) return no(409, "This pre-approval is not waiting for review.");
    const prev = await tx.query("SELECT extracted_data->>'lender' AS lender FROM prequalification_summaries WHERE prequalification_id = $1::uuid ORDER BY created_at DESC LIMIT 1", [id]);
    const price = r.rows[0]["listing_id"] ? (await tx.query("SELECT price_cents FROM property_listing WHERE id = $1::uuid", [r.rows[0]["listing_id"]])).rows[0]?.["price_cents"] : undefined;
    const lender = prev.rows[0]?.["lender"] ? String(prev.rows[0]["lender"]) : undefined;
    const expiresAt = `${input.expiresOn}T23:59:59.000Z`;
    const a = assess({ approvedCents: input.approvedCents, conditions: input.conditions, expiresAt, lender, now, priceCents: price == null ? undefined : Number(price) });
    const extracted: Extracted = {
      ...(lender ? { lender } : {}), ...(input.approvedCents !== undefined ? { approvedCents: input.approvedCents } : {}),
      ...(input.ratePercent !== undefined ? { ratePercent: input.ratePercent } : {}), ...(input.termYears !== undefined ? { termYears: input.termYears } : {}),
      ...(input.expiresOn ? { expiresOn: input.expiresOn } : {}), conditions: input.conditions
    };
    await tx.query(
      `INSERT INTO prequalification_summaries (prequalification_id, confidence_level, extracted_data, elena_summary, red_flags, engine, source)
       VALUES ($1::uuid,$2,$3::jsonb,$4,$5::jsonb,$6,'staff')`,
      [id, a.confidence, JSON.stringify(extracted), a.summary, JSON.stringify(a.flags), PREQUAL_ENGINE]
    );
    await audit(tx, staff.id, id, "prequal.verified", { role: staff.role, confidence: a.confidence });
    return { ok: true as const, value: { status: "verified" as PrequalStatus } };
  });
}

/**
 * Bulk "approve what Elena read cleanly": a pending letter is verified only when Elena found the amount and expiry date and her
 * confidence is not low. Anything else is skipped and stays pending for a person to look at.
 */
export async function bulkVerify(db: Queryable, staff: StaffRef, ids: readonly string[], now: string, today: string): Promise<{ verified: number; skipped: number }> {
  let verified = 0;
  for (const id of ids) {
    const d = await staffDetail(db, id, now);
    const e = d?.elena;
    if (!d || d.status !== "pending_review" || !e || e.confidence === "low" || !e.extracted.approvedCents || !e.extracted.expiresOn || e.extracted.expiresOn <= today) continue;
    const r = await reviewPrequal(db, staff, id, {
      action: "verify", approvedCents: e.extracted.approvedCents, expiresOn: e.extracted.expiresOn, conditions: e.extracted.conditions,
      ...(e.extracted.ratePercent !== undefined ? { ratePercent: e.extracted.ratePercent } : {}), ...(e.extracted.termYears !== undefined ? { termYears: e.extracted.termYears } : {})
    }, now);
    if (r.ok) verified++;
  }
  return { verified, skipped: ids.length - verified };
}
