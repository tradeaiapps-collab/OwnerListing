import { randomUUID } from "node:crypto";
import { applyPaymentEvent, type Invoice } from "../domain/billing";
import type { FinanceRaw, GroupRow, MonthRow, Totals } from "../domain/finance-report";
import { isBillingInterval } from "../domain/plans";
import { createPgBillingStore, INVOICE_COLS, toInvoice } from "./billing-db";
import { appendAuditPg, type Queryable } from "./db";
import { currentMonthlyPrices, isUuid, toDispute, type DisputeView } from "./subscription-db";

const n = (v: unknown) => Number(v ?? 0);
const totals = (r: Record<string, unknown> | undefined, p: string): Totals => ({ exGstCents: n(r?.[`${p}ex`]), gstCents: n(r?.[`${p}gst`]), totalCents: n(r?.[`${p}total`]), count: n(r?.[`${p}n`]) });
const group = (r: Record<string, unknown>): GroupRow => ({ key: String(r["key"] ?? "unknown"), totalCents: n(r["total"]), exGstCents: n(r["ex"]), count: n(r["n"]) });

export const FINANCE_DAYS = [7, 30, 90, 365] as const;

/**
 * Grouped money figures for the admin finance dashboard over the last `days` days and the `days` before. Totals only: no names, emails
 * or card data are selected. Revenue is paid invoices by paid_at.
 */
export async function loadFinanceRaw(db: Queryable, days: number): Promise<FinanceRaw> {
  const span = `${Math.max(1, Math.trunc(days))} days`;
  const [win, monthly, kind, method, attempts, outstanding, subs, churn, disputes, repeat, prices] = await Promise.all([
    db.query(`SELECT
        COALESCE(sum(amount_ex_gst_cents) FILTER (WHERE paid_at >= now() - $1::interval), 0)::text AS cex,
        COALESCE(sum(gst_cents) FILTER (WHERE paid_at >= now() - $1::interval), 0)::text AS cgst,
        COALESCE(sum(total_cents) FILTER (WHERE paid_at >= now() - $1::interval), 0)::text AS ctotal,
        count(*) FILTER (WHERE paid_at >= now() - $1::interval)::int AS cn,
        COALESCE(sum(amount_ex_gst_cents) FILTER (WHERE paid_at < now() - $1::interval AND paid_at >= now() - 2 * $1::interval), 0)::text AS pex,
        COALESCE(sum(gst_cents) FILTER (WHERE paid_at < now() - $1::interval AND paid_at >= now() - 2 * $1::interval), 0)::text AS pgst,
        COALESCE(sum(total_cents) FILTER (WHERE paid_at < now() - $1::interval AND paid_at >= now() - 2 * $1::interval), 0)::text AS ptotal,
        count(*) FILTER (WHERE paid_at < now() - $1::interval AND paid_at >= now() - 2 * $1::interval)::int AS pn
      FROM invoice WHERE status = 'paid'`, [span]),
    db.query(`SELECT to_char(paid_at AT TIME ZONE 'UTC', 'YYYY-MM') AS month, sum(amount_ex_gst_cents)::text AS ex, sum(gst_cents)::text AS gst,
                     sum(total_cents)::text AS total, count(*)::int AS n
                FROM invoice WHERE status = 'paid' AND paid_at >= date_trunc('month', now() AT TIME ZONE 'UTC') - interval '11 months'
               GROUP BY 1 ORDER BY 1`),
    db.query(`SELECT kind AS key, sum(total_cents)::text AS total, sum(amount_ex_gst_cents)::text AS ex, count(*)::int AS n
                FROM invoice WHERE status = 'paid' AND paid_at >= now() - $1::interval GROUP BY kind ORDER BY sum(total_cents) DESC`, [span]),
    db.query(`SELECT COALESCE(payment_method, 'card') AS key, sum(total_cents)::text AS total, sum(amount_ex_gst_cents)::text AS ex, count(*)::int AS n
                FROM invoice WHERE status = 'paid' AND paid_at >= now() - $1::interval GROUP BY 1 ORDER BY sum(total_cents) DESC`, [span]),
    db.query(`SELECT count(*) FILTER (WHERE outcome = 'succeeded' AND received_at >= now() - $1::interval)::int AS s,
                     count(*) FILTER (WHERE outcome = 'failed' AND received_at >= now() - $1::interval)::int AS f,
                     count(*) FILTER (WHERE outcome = 'succeeded' AND received_at < now() - $1::interval AND received_at >= now() - 2 * $1::interval)::int AS ps,
                     count(*) FILTER (WHERE outcome = 'failed' AND received_at < now() - $1::interval AND received_at >= now() - 2 * $1::interval)::int AS pf
                FROM payment_event WHERE provider <> 'bank_transfer'`, [span]),
    db.query(`SELECT count(*)::int AS n, COALESCE(sum(total_cents), 0)::text AS total,
                     count(*) FILTER (WHERE due_at < now())::int AS od_n,
                     COALESCE(sum(total_cents) FILTER (WHERE due_at < now()), 0)::text AS od_total,
                     COALESCE(max(floor(extract(epoch FROM (now() - due_at)) / 86400)) FILTER (WHERE due_at < now()), 0)::int AS oldest
                FROM invoice WHERE status = 'pending'`),
    db.query(`SELECT plan_id, billing_interval, status, price_snapshot_cents::text AS price, count(*)::int AS n
                FROM subscription WHERE status IN ('active','past_due') GROUP BY 1,2,3,4`),
    db.query(`SELECT count(*) FILTER (WHERE cancelled_at >= now() - $1::interval OR (status = 'expired' AND ends_at >= now() - $1::interval))::int AS churned,
                     count(*) FILTER (WHERE status <> 'pending' AND created_at >= now() - $1::interval)::int AS started
                FROM subscription`, [span]),
    db.query(`SELECT count(*)::int AS n FROM payment_dispute WHERE status = 'open'`),
    db.query(`SELECT count(*)::int AS owners, COALESCE(avg(spent), 0)::bigint::text AS avg_spent FROM (
                SELECT owner_user_id, sum(amount_ex_gst_cents) AS spent FROM invoice
                 WHERE kind = 'listing_fee' AND status = 'paid' AND paid_at >= now() - interval '90 days'
                   AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.owner_user_id = invoice.owner_user_id AND s.status IN ('active','past_due'))
                 GROUP BY owner_user_id HAVING count(*) >= 2) t`),
    currentMonthlyPrices(db)
  ]);
  const o = outstanding.rows[0];
  return {
    days,
    current: totals(win.rows[0], "c"),
    previous: totals(win.rows[0], "p"),
    monthly: monthly.rows.map((r): MonthRow => ({ month: String(r["month"]), exGstCents: n(r["ex"]), gstCents: n(r["gst"]), totalCents: n(r["total"]), count: n(r["n"]) })),
    byKind: kind.rows.map(group),
    byMethod: method.rows.map(group),
    attempts: { succeeded: n(attempts.rows[0]?.["s"]), failed: n(attempts.rows[0]?.["f"]), previousSucceeded: n(attempts.rows[0]?.["ps"]), previousFailed: n(attempts.rows[0]?.["pf"]) },
    outstanding: { count: n(o?.["n"]), totalCents: n(o?.["total"]) },
    overdue: { count: n(o?.["od_n"]), totalCents: n(o?.["od_total"]), oldestDays: n(o?.["oldest"]) },
    subscriptions: subs.rows.map(r => ({ planId: String(r["plan_id"]), interval: isBillingInterval(r["billing_interval"]) ? r["billing_interval"] : "monthly", status: String(r["status"]), priceCents: n(r["price"]), count: n(r["n"]) })),
    churned: n(churn.rows[0]?.["churned"]), newSubscriptions: n(churn.rows[0]?.["started"]),
    openDisputes: n(disputes.rows[0]?.["n"]),
    repeatListers: { owners: n(repeat.rows[0]?.["owners"]), avgSpentExGstCents: n(repeat.rows[0]?.["avg_spent"]) },
    monthlyPrices: prices
  };
}

export type InvoiceFilter = "all" | "pending" | "overdue" | "paid" | "failed";
export interface StaffInvoiceRow extends Invoice { ownerRef: string; disputeOpen: boolean }
export const INVOICE_FILTERS: readonly InvoiceFilter[] = ["all", "pending", "overdue", "paid", "failed"];

/** Latest 100 invoices for the finance screen. The customer is shown as a short reference only (no name or email). */
export async function listStaffInvoices(db: Queryable, filter: InvoiceFilter): Promise<StaffInvoiceRow[]> {
  const where = filter === "pending" ? "i.status = 'pending'" : filter === "overdue" ? "i.status = 'pending' AND i.due_at < now()"
    : filter === "paid" ? "i.status = 'paid'" : filter === "failed" ? "i.status IN ('failed','void')" : "true";
  const res = await db.query(
    `SELECT ${INVOICE_COLS.split(", ").map(c => `i.${c}`).join(", ")}, left(i.owner_user_id::text, 8) AS owner_ref,
            EXISTS (SELECT 1 FROM payment_dispute d WHERE d.invoice_id = i.id AND d.status = 'open') AS dispute_open
       FROM invoice i WHERE ${where} ORDER BY i.created_at DESC, i.id DESC LIMIT 100`);
  return res.rows.map(r => ({ ...toInvoice(r), ownerRef: String(r["owner_ref"]), disputeOpen: r["dispute_open"] === true }));
}

export interface StaffDisputeRow extends DisputeView { invoiceNumber: string; totalCents: number; ownerRef: string }

export async function listDisputes(db: Queryable, status: "open" | "closed"): Promise<StaffDisputeRow[]> {
  const res = await db.query(
    `SELECT d.id, d.invoice_id, d.status, d.reason, d.resolution, d.created_at, i.invoice_number, i.total_cents, left(d.raised_by::text, 8) AS owner_ref
       FROM payment_dispute d JOIN invoice i ON i.id = d.invoice_id
      WHERE ${status === "open" ? "d.status = 'open'" : "d.status <> 'open'"} ORDER BY d.created_at DESC LIMIT 100`);
  return res.rows.map(r => ({ ...toDispute(r), invoiceNumber: String(r["invoice_number"]), totalCents: n(r["total_cents"]), ownerRef: String(r["owner_ref"]) }));
}

export type StaffActionResult = { ok: true; note?: string } | { ok: false; status: 400 | 404 | 409; error: string };
const audit = (db: Queryable, staffId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType: "user", actorId: staffId, aggregateType, aggregateId, eventType, correlationId: randomUUID(), payload });

export const MIN_STAFF_NOTE = 10;

/**
 * Staff confirm that a bank transfer for an invoice arrived. The amount staff type must equal the invoice total exactly; anything else is
 * refused (the customer may have paid the wrong amount, which needs a person to sort out). Applies through the same payment path as a card
 * payment: idempotent by event id, marks a listing fee paid, and starts or extends a subscription.
 */
export async function confirmBankTransfer(db: Queryable, staffId: string, invoiceId: string, amountCents: number, reference: string): Promise<StaffActionResult> {
  if (!isUuid(invoiceId)) return { ok: false, status: 404, error: "Invoice not found." };
  if (reference.trim().length < 3 || reference.length > 100) return { ok: false, status: 400, error: "Enter the bank reference (3 to 100 characters)." };
  const store = createPgBillingStore(db);
  const invoice = await store.getInvoice(invoiceId);
  if (!invoice) return { ok: false, status: 404, error: "Invoice not found." };
  const event = { eventId: `bank:${invoice.id}`, invoiceId: invoice.id, amountCents, outcome: "succeeded" as const, providerRef: `bank:${reference.trim()}`, provider: "bank_transfer" as const };
  if (invoice.status === "paid") return { ok: true, note: "Already paid." };
  if (invoice.status !== "pending") return { ok: false, status: 409, error: `This invoice is ${invoice.status} and cannot be marked paid.` };
  try {
    const applied = applyPaymentEvent(invoice, event, new Set());
    await store.settle(applied.invoice, event);
  } catch (e) {
    return { ok: false, status: 409, error: e instanceof Error ? e.message : "Payment could not be applied." };
  }
  await audit(db, staffId, "invoice", invoice.id, "invoice.bank_transfer_confirmed", { amountCents, reference: reference.trim() });
  return { ok: true, note: "Marked paid." };
}

/** Staff answer a customer's payment issue. Resolving does not move money; a refund, if any, is made outside this system and noted here. */
export async function resolveDispute(db: Queryable, staffId: string, disputeId: string, outcome: "resolved" | "rejected", resolution: string): Promise<StaffActionResult> {
  if (!isUuid(disputeId)) return { ok: false, status: 404, error: "Payment issue not found." };
  const text = resolution.trim();
  if (text.length < MIN_STAFF_NOTE || text.length > 1000) return { ok: false, status: 400, error: `Write the answer for the customer (${MIN_STAFF_NOTE} to 1000 characters).` };
  const res = await db.query(
    "UPDATE payment_dispute SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING invoice_id",
    [disputeId, outcome, text, staffId]);
  if (res.rows.length === 0) {
    const exists = await db.query("SELECT 1 FROM payment_dispute WHERE id = $1", [disputeId]);
    return exists.rows.length ? { ok: false, status: 409, error: "This payment issue is already closed." } : { ok: false, status: 404, error: "Payment issue not found." };
  }
  await audit(db, staffId, "invoice", String(res.rows[0]?.["invoice_id"]), `invoice.dispute_${outcome}`, { disputeId });
  return { ok: true };
}
