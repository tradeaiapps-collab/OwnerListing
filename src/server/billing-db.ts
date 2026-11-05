import { randomUUID } from "node:crypto";
import type { BillingStore, PriceRow } from "../domain/billing-service";
import { INVOICE_TERMS_DAYS, type Invoice, type PaymentEvent } from "../domain/billing";
import { appendAuditPg, type Queryable } from "./db";
import { afterPeriodPaid, type SubscriptionRow } from "../domain/subscriptions";
import { isBillingInterval } from "../domain/plans";

const PROVIDER = "payway";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const audit = (db: Queryable, actorType: "user" | "system", actorId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType, actorId, aggregateType, aggregateId, eventType, correlationId: randomUUID(), payload });

export const INVOICE_COLS =
  "id, owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, provider_ref, listing_id, plan_id, invoice_number, kind, description, due_at, payment_method, subscription_id, created_at, paid_at";
const COLS = INVOICE_COLS;
const iso = (v: unknown) => new Date(v as string | Date).toISOString();

export function toInvoice(r: Record<string, unknown>): Invoice {
  return {
    id: String(r["id"]), ownerUserId: String(r["owner_user_id"]),
    amountExGstCents: Number(r["amount_ex_gst_cents"]), gstCents: Number(r["gst_cents"]), totalCents: Number(r["total_cents"]),
    status: r["status"] as Invoice["status"],
    ...(r["provider_ref"] ? { providerRef: String(r["provider_ref"]) } : {}),
    ...(r["listing_id"] ? { listingId: String(r["listing_id"]) } : {}),
    ...(r["plan_id"] ? { planId: String(r["plan_id"]) } : {}),
    ...(r["invoice_number"] ? { invoiceNumber: String(r["invoice_number"]) } : {}),
    ...(r["kind"] ? { kind: r["kind"] as NonNullable<Invoice["kind"]> } : {}),
    ...(r["description"] ? { description: String(r["description"]) } : {}),
    ...(r["due_at"] ? { dueAt: iso(r["due_at"]) } : {}),
    ...(r["payment_method"] ? { paymentMethod: r["payment_method"] as NonNullable<Invoice["paymentMethod"]> } : {}),
    ...(r["subscription_id"] ? { subscriptionId: String(r["subscription_id"]) } : {}),
    ...(r["created_at"] ? { createdAt: iso(r["created_at"]) } : {}),
    ...(r["paid_at"] ? { paidAt: iso(r["paid_at"]) } : {})
  };
}

/** True when this call recorded the event; false when the event id was already there (a replay, or a concurrent duplicate). */
const recordEvent = async (db: Queryable, e: PaymentEvent): Promise<boolean> => (await db.query(
  "INSERT INTO payment_event (event_id, invoice_id, provider, outcome, amount_cents) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
  [e.eventId, e.invoiceId, e.provider ?? PROVIDER, e.outcome, e.amountCents]
)).rows.length > 0;

/** Runs a multi-step billing write in one transaction. Only a test double without transaction support runs the steps directly. */
const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));

/** PostgreSQL billing store. Parameterised queries only. No card data exists here: customers pay on the provider's hosted page. */
export function createPgBillingStore(db: Queryable): BillingStore {
  return {
    async listingOwner(listingId) {
      if (!UUID_RE.test(listingId)) return undefined;
      const res = await db.query("SELECT owner_user_id FROM property_listing WHERE id = $1", [listingId]);
      const o = res.rows[0]?.["owner_user_id"];
      return typeof o === "string" ? o : undefined;
    },
    async currentPrices() {
      const res = await db.query(
        "SELECT DISTINCT ON (plan_id) plan_id, price_cents FROM plan_price WHERE effective_from <= now() ORDER BY plan_id, effective_from DESC, id DESC"
      );
      return Object.fromEntries(res.rows.map(r => [String(r["plan_id"]), Number(r["price_cents"])]));
    },
    async priceHistory() {
      const res = await db.query(
        "SELECT id, plan_id, price_cents, reason, set_by, effective_from FROM plan_price ORDER BY effective_from DESC, id DESC LIMIT 200"
      );
      return res.rows.map((r): PriceRow => ({
        id: String(r["id"]), planId: String(r["plan_id"]), priceCents: Number(r["price_cents"]), reason: String(r["reason"]),
        setBy: String(r["set_by"]), effectiveFrom: new Date(r["effective_from"] as string | Date).toISOString()
      }));
    },
    async addPrice({ planId, priceCents, reason, setBy }) {
      await atomic(db, async tx => {
        const res = await tx.query(
          "INSERT INTO plan_price (plan_id, price_cents, set_by, reason) VALUES ($1,$2,$3,$4) RETURNING id", [planId, priceCents, setBy, reason]
        );
        await audit(tx, "user", setBy, "plan_price", String(res.rows[0]?.["id"] ?? planId), "pricing.set", { planId, priceCents, reason });
      });
    },
    async invoicesForListing(listingId) {
      const res = await db.query(`SELECT ${COLS} FROM invoice WHERE listing_id = $1 AND status IN ('pending','paid')`, [listingId]);
      return res.rows.map(toInvoice);
    },
    async getInvoice(id) {
      const res = await db.query(`SELECT ${COLS} FROM invoice WHERE id = $1`, [id]);
      return res.rows[0] ? toInvoice(res.rows[0]) : undefined;
    },
    async replaceInvoices(supersedeIds, inv) {
      // One transaction: the old pending invoices are never failed without the replacement (and its audit row) existing.
      await atomic(db, async tx => {
        if (supersedeIds.length > 0) {
          await tx.query("UPDATE invoice SET status = 'failed' WHERE id = ANY($1::uuid[]) AND status = 'pending'", [supersedeIds]);
        }
        await tx.query(
          `INSERT INTO invoice (id, owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, listing_id, plan_id, provider, kind, due_at)
           VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,'listing_fee', now() + make_interval(days => ${INVOICE_TERMS_DAYS}))`,
          [inv.id, inv.ownerUserId, inv.amountExGstCents, inv.gstCents, inv.totalCents, inv.listingId ?? null, inv.planId ?? null, PROVIDER]
        );
        await audit(tx, "user", inv.ownerUserId, "invoice", inv.id, "invoice.created", { listingId: inv.listingId, planId: inv.planId, totalCents: inv.totalCents });
      });
    },
    async eventSeen(eventId) {
      const res = await db.query("SELECT 1 FROM payment_event WHERE event_id = $1", [eventId]);
      return res.rows.length > 0;
    },
    async settle(inv, e) {
      const paid = e.outcome === "succeeded";
      // One transaction. The event row goes in first: its primary key makes a replay or a concurrent duplicate a no-op.
      await atomic(db, async tx => {
        if (!(await recordEvent(tx, e))) return;
        const upd = await tx.query(
          `UPDATE invoice SET status = $2, provider_ref = $3, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END,
             payment_method = CASE WHEN $2 = 'paid' THEN $4 ELSE payment_method END
           WHERE id = $1 AND status = 'pending' RETURNING id, paid_at, subscription_id`,
          [inv.id, paid ? "paid" : "failed", e.providerRef, e.provider === "bank_transfer" ? "bank_transfer" : "card"]
        );
        if (upd.rows.length === 0) {
          // The invoice was settled or replaced after it was read. Never mark the listing paid; a payment needs a person to look at it.
          if (paid) {
            await tx.query("INSERT INTO admin_case (kind, subject_id, reason) VALUES ('other', $1, $2)", [inv.id, `Payment ${e.eventId}: invoice was no longer pending when the payment arrived.`]);
            await audit(tx, "system", PROVIDER, "invoice", inv.id, "invoice.payment_mismatch", { eventId: e.eventId, amountCents: e.amountCents, reason: "invoice no longer pending" });
          }
          return;
        }
        if (paid && inv.listingId) {
          await tx.query("UPDATE property_listing SET listing_fee_paid = true, updated_at = now() WHERE id = $1 AND owner_user_id = $2", [inv.listingId, inv.ownerUserId]);
        }
        const subId = upd.rows[0]?.["subscription_id"];
        if (paid && typeof subId === "string") await extendSubscription(tx, subId, iso(upd.rows[0]?.["paid_at"]), inv.id);
        await audit(tx, "system", e.provider ?? PROVIDER, "invoice", inv.id, paid ? "invoice.paid" : "invoice.payment_failed", { eventId: e.eventId, amountCents: e.amountCents });
      });
    },
    async flagMismatch(inv, e, reason) {
      await atomic(db, async tx => {
        if (!(await recordEvent(tx, e))) return;
        await tx.query("INSERT INTO admin_case (kind, subject_id, reason) VALUES ('other', $1, $2)", [inv.id, `Payment ${e.eventId}: ${reason}`]);
        await audit(tx, "system", PROVIDER, "invoice", inv.id, "invoice.payment_mismatch", { eventId: e.eventId, amountCents: e.amountCents, reason });
      });
    }
  };
}

const SUB_COLS = "id, owner_user_id, plan_id, billing_interval, status, starts_at, ends_at, cancel_at_period_end, price_snapshot_cents";

export function toSubscription(r: Record<string, unknown>): SubscriptionRow {
  return {
    id: String(r["id"]), ownerUserId: String(r["owner_user_id"]), planId: String(r["plan_id"]),
    interval: isBillingInterval(r["billing_interval"]) ? r["billing_interval"] : "monthly",
    status: r["status"] as SubscriptionRow["status"], startsAt: iso(r["starts_at"]), endsAt: iso(r["ends_at"]),
    cancelAtPeriodEnd: r["cancel_at_period_end"] === true, priceSnapshotCents: Number(r["price_snapshot_cents"])
  };
}

/** Called inside the settle transaction when a subscription invoice is paid: starts or extends the period, or flags an expired one to staff. */
async function extendSubscription(tx: Queryable, subscriptionId: string, paidAt: string, invoiceId: string): Promise<void> {
  const res = await tx.query(`SELECT ${SUB_COLS} FROM subscription WHERE id = $1 FOR UPDATE`, [subscriptionId]);
  if (!res.rows[0]) return;
  const next = afterPeriodPaid(toSubscription(res.rows[0]), paidAt);
  if (!next) {
    await tx.query("INSERT INTO admin_case (kind, subject_id, reason) VALUES ('other', $1, $2)", [invoiceId, "A subscription invoice was paid after the subscription ended. It was not restarted; staff to refund or restart it."]);
    return;
  }
  await tx.query("UPDATE subscription SET status = 'active', starts_at = $2, ends_at = $3 WHERE id = $1", [subscriptionId, next.startsAt, next.endsAt]);
  await audit(tx, "system", PROVIDER, "subscription", subscriptionId, "subscription.period_paid", { invoiceId, endsAt: next.endsAt });
}
