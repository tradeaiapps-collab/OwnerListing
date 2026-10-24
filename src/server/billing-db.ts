import { randomUUID } from "node:crypto";
import type { BillingStore, PriceRow } from "../domain/billing-service";
import type { Invoice, PaymentEvent } from "../domain/billing";
import { appendAuditPg, type Queryable } from "./db";

const PROVIDER = "payway";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const audit = (db: Queryable, actorType: "user" | "system", actorId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType, actorId, aggregateType, aggregateId, eventType, correlationId: randomUUID(), payload });

const COLS = "id, owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, provider_ref, listing_id, plan_id";

function toInvoice(r: Record<string, unknown>): Invoice {
  return {
    id: String(r["id"]), ownerUserId: String(r["owner_user_id"]),
    amountExGstCents: Number(r["amount_ex_gst_cents"]), gstCents: Number(r["gst_cents"]), totalCents: Number(r["total_cents"]),
    status: r["status"] as Invoice["status"],
    ...(r["provider_ref"] ? { providerRef: String(r["provider_ref"]) } : {}),
    ...(r["listing_id"] ? { listingId: String(r["listing_id"]) } : {}),
    ...(r["plan_id"] ? { planId: String(r["plan_id"]) } : {})
  };
}

/** True when this call recorded the event; false when the event id was already there (a replay, or a concurrent duplicate). */
const recordEvent = async (db: Queryable, e: PaymentEvent): Promise<boolean> => (await db.query(
  "INSERT INTO payment_event (event_id, invoice_id, provider, outcome, amount_cents) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (event_id) DO NOTHING RETURNING event_id",
  [e.eventId, e.invoiceId, PROVIDER, e.outcome, e.amountCents]
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
          `INSERT INTO invoice (id, owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, listing_id, plan_id, provider)
           VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
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
          `UPDATE invoice SET status = $2, provider_ref = $3, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END
           WHERE id = $1 AND status = 'pending' RETURNING id`,
          [inv.id, paid ? "paid" : "failed", e.providerRef]
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
        await audit(tx, "system", PROVIDER, "invoice", inv.id, paid ? "invoice.paid" : "invoice.payment_failed", { eventId: e.eventId, amountCents: e.amountCents });
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
