import { randomUUID } from "node:crypto";
import { INVOICE_TERMS_DAYS, addDays, createSubscriptionInvoice, type Invoice } from "../domain/billing";
import { reminderEmail, reminderToSend, type ReminderStage } from "../domain/billing-reminders";
import { SUBSCRIPTION_PLANS, type BillingInterval } from "../domain/plans";
import { periodQuote, planAllowedFor, subscriptionAction, type SubscriptionRow } from "../domain/subscriptions";
import type { EmailPort } from "../adapters/email";
import { INVOICE_COLS, toInvoice, toSubscription } from "./billing-db";
import { appendAuditPg, type Queryable } from "./db";

const SUB_COLS = "id, owner_user_id, plan_id, billing_interval, status, starts_at, ends_at, cancel_at_period_end, price_snapshot_cents";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const atomic = <T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> => (db.transaction ? db.transaction(fn) : fn(db));
const audit = (db: Queryable, actorType: "user" | "system", actorId: string, aggregateType: string, aggregateId: string, eventType: string, payload: Record<string, unknown>) =>
  appendAuditPg(db, { id: randomUUID(), occurredAt: new Date().toISOString(), actorType, actorId, aggregateType, aggregateId, eventType, correlationId: randomUUID(), payload });

export interface DisputeView { id: string; invoiceId: string; status: "open" | "resolved" | "rejected"; reason: string; resolution?: string; createdAt: string }
export interface MyBilling { invoices: Invoice[]; subscription?: SubscriptionRow; disputes: DisputeView[]; recentListingFees: { count: number; exGstCents: number } }

const iso = (v: unknown) => new Date(v as string | Date).toISOString();
export const toDispute = (r: Record<string, unknown>): DisputeView => ({
  id: String(r["id"]), invoiceId: String(r["invoice_id"]), status: r["status"] as DisputeView["status"], reason: String(r["reason"]),
  ...(r["resolution"] ? { resolution: String(r["resolution"]) } : {}), createdAt: iso(r["created_at"])
});

/** Everything on the Billing page for one signed-in person. Only that person's rows are read. */
export async function loadMyBilling(db: Queryable, userId: string): Promise<MyBilling> {
  const [inv, sub, dis, recent] = await Promise.all([
    db.query(`SELECT ${INVOICE_COLS} FROM invoice WHERE owner_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`, [userId]),
    db.query(`SELECT ${SUB_COLS} FROM subscription WHERE owner_user_id = $1 AND status IN ('pending','active','past_due') LIMIT 1`, [userId]),
    db.query(`SELECT d.id, d.invoice_id, d.status, d.reason, d.resolution, d.created_at FROM payment_dispute d WHERE d.raised_by = $1 ORDER BY d.created_at DESC LIMIT 100`, [userId]),
    db.query(`SELECT count(*)::int AS n, COALESCE(sum(amount_ex_gst_cents), 0)::text AS ex FROM invoice
              WHERE owner_user_id = $1 AND kind = 'listing_fee' AND status = 'paid' AND paid_at >= now() - interval '90 days'`, [userId])
  ]);
  return {
    invoices: inv.rows.map(toInvoice),
    ...(sub.rows[0] ? { subscription: toSubscription(sub.rows[0]) } : {}),
    disputes: dis.rows.map(toDispute),
    recentListingFees: { count: Number(recent.rows[0]?.["n"] ?? 0), exGstCents: Number(recent.rows[0]?.["ex"] ?? 0) }
  };
}

/** One of the person's own invoices, or undefined (other people's invoices look like they do not exist). */
export async function getMyInvoice(db: Queryable, userId: string, invoiceId: string): Promise<Invoice | undefined> {
  if (!isUuid(invoiceId)) return undefined;
  const r = await db.query(`SELECT ${INVOICE_COLS} FROM invoice WHERE id = $1 AND owner_user_id = $2`, [invoiceId, userId]);
  return r.rows[0] ? toInvoice(r.rows[0]) : undefined;
}

export async function currentMonthlyPrices(db: Queryable): Promise<Record<string, number>> {
  const res = await db.query("SELECT DISTINCT ON (plan_id) plan_id, price_cents FROM plan_price WHERE effective_from <= now() ORDER BY plan_id, effective_from DESC, id DESC");
  return Object.fromEntries(res.rows.map(r => [String(r["plan_id"]), Number(r["price_cents"])]));
}

export type SubscribeResult =
  | { ok: true; invoice: Invoice; subscription: SubscriptionRow }
  | { ok: false; code: "invalid" | "conflict"; message: string };

/**
 * Starts a subscription: a pending subscription plus its first invoice. Nothing is active until that invoice is paid. Only a plan for the
 * person's own account type (owner or agent) with an admin-set price can be bought; the period price is locked on the subscription.
 * Asking again for the same plan and interval returns the same pending invoice; choosing another plan replaces the pending one.
 */
export async function startSubscription(db: Queryable, userId: string, userType: string, planId: string, interval: BillingInterval, now: string): Promise<SubscribeResult> {
  if (!planAllowedFor(userType, planId)) return { ok: false, code: "invalid", message: "That plan is not available for your account type." };
  const price = periodQuote(planId, interval, await currentMonthlyPrices(db));
  if (price === null) return { ok: false, code: "invalid", message: "This plan's price has not been set, so it cannot be bought yet." };
  const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
  return atomic(db, async tx => {
    const live = await tx.query(`SELECT ${SUB_COLS} FROM subscription WHERE owner_user_id = $1 AND status IN ('pending','active','past_due') FOR UPDATE`, [userId]);
    const existing = live.rows[0] ? toSubscription(live.rows[0]) : undefined;
    if (existing && existing.status !== "pending") return { ok: false as const, code: "conflict" as const, message: "You already have a plan. Cancel it first to choose another." };
    if (existing && existing.planId === planId && existing.interval === interval) {
      const inv = await tx.query(`SELECT ${INVOICE_COLS} FROM invoice WHERE subscription_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [existing.id]);
      if (inv.rows[0]) return { ok: true as const, invoice: toInvoice(inv.rows[0]), subscription: existing };
    }
    if (existing) {
      await tx.query("UPDATE subscription SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [existing.id]);
      await tx.query("UPDATE invoice SET status = 'void' WHERE subscription_id = $1 AND status = 'pending'", [existing.id]);
    }
    const subId = randomUUID();
    await tx.query(
      `INSERT INTO subscription (id, owner_user_id, plan_id, add_ons, price_snapshot_cents, status, starts_at, ends_at, billing_interval)
       VALUES ($1,$2,$3,'[]'::jsonb,$4,'pending',$5,$5,$6)`, [subId, userId, planId, price, now, interval]);
    const invoice = createSubscriptionInvoice(randomUUID(), userId, subId, planId, price, `${plan?.name ?? planId} plan, first ${interval === "yearly" ? "year" : "month"}`, addDays(now, INVOICE_TERMS_DAYS));
    await insertSubscriptionInvoice(tx, invoice);
    await audit(tx, "user", userId, "subscription", subId, "subscription.started", { planId, interval, priceCents: price });
    const sub = (await tx.query(`SELECT ${SUB_COLS} FROM subscription WHERE id = $1`, [subId])).rows[0];
    return { ok: true as const, invoice: { ...invoice }, subscription: toSubscription(sub ?? {}) };
  });
}

async function insertSubscriptionInvoice(tx: Queryable, i: Invoice): Promise<void> {
  await tx.query(
    `INSERT INTO invoice (id, owner_user_id, amount_ex_gst_cents, gst_cents, total_cents, status, plan_id, provider, kind, description, due_at, subscription_id)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,'payway','subscription',$7,$8,$9)`,
    [i.id, i.ownerUserId, i.amountExGstCents, i.gstCents, i.totalCents, i.planId ?? null, i.description ?? null, i.dueAt ?? null, i.subscriptionId ?? null]
  );
}

export type SimpleResult = { ok: true } | { ok: false; code: "not_found" | "invalid"; message: string };

/** Cancel at the end of the paid period (or at once if it was never paid). Features stay until the period ends. Undo with cancel=false. */
export async function setCancelAtPeriodEnd(db: Queryable, userId: string, cancel: boolean): Promise<SimpleResult> {
  return atomic(db, async tx => {
    const res = await tx.query(`SELECT ${SUB_COLS} FROM subscription WHERE owner_user_id = $1 AND status IN ('pending','active','past_due') FOR UPDATE`, [userId]);
    const sub = res.rows[0] ? toSubscription(res.rows[0]) : undefined;
    if (!sub) return { ok: false as const, code: "not_found" as const, message: "You don't have a plan to change." };
    if (sub.status === "pending") {
      if (!cancel) return { ok: false as const, code: "invalid" as const, message: "Nothing to resume." };
      await tx.query("UPDATE subscription SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [sub.id]);
      await tx.query("UPDATE invoice SET status = 'void' WHERE subscription_id = $1 AND status = 'pending'", [sub.id]);
    } else {
      await tx.query("UPDATE subscription SET cancel_at_period_end = $2, cancelled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [sub.id, cancel]);
      // A renewal invoice that was already issued is no longer wanted.
      if (cancel) await tx.query("UPDATE invoice SET status = 'void' WHERE subscription_id = $1 AND status = 'pending' AND created_at > $2", [sub.id, sub.startsAt]);
    }
    await audit(tx, "user", userId, "subscription", sub.id, cancel ? "subscription.cancel_requested" : "subscription.resumed", {});
    return { ok: true as const };
  });
}

export type DisputeResult = { ok: true; id: string } | { ok: false; code: "not_found" | "invalid"; message: string };

/** A person raises a payment issue on their own invoice. One open issue per invoice. Staff answer it; nothing changes automatically. */
export async function raiseDispute(db: Queryable, userId: string, invoiceId: string, reason: string): Promise<DisputeResult> {
  if (!(await getMyInvoice(db, userId, invoiceId))) return { ok: false, code: "not_found", message: "Invoice not found." };
  return atomic(db, async tx => {
    const id = randomUUID();
    const ins = await tx.query("INSERT INTO payment_dispute (id, invoice_id, raised_by, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [id, invoiceId, userId, reason]);
    if (ins.rows.length === 0) return { ok: false as const, code: "invalid" as const, message: "There is already an open payment issue on this invoice." };
    await tx.query("INSERT INTO admin_case (kind, subject_id, reason) VALUES ('other', $1, $2)", [invoiceId, "Payment issue raised by the customer. See Finance, Payment issues."]);
    await audit(tx, "user", userId, "invoice", invoiceId, "invoice.dispute_raised", { disputeId: id });
    return { ok: true as const, id };
  });
}

export interface CycleDeps { email: EmailPort; siteName: string; baseUrl: string }
export interface CycleCounts { renewalInvoices: number; pastDue: number; expired: number; ended: number; remindersSent: number; remindersSkipped: number }

/**
 * The daily billing run (called by a scheduler with a secret, see app/api/internal/billing/run). Safe to run more than once a day:
 * a renewal invoice is only issued when none is open, a subscription moves state only when its dates say so, and each reminder
 * stage is recorded once it has been sent. Nothing here charges anyone; paying an invoice is always the customer's own action.
 */
export async function runBillingCycle(db: Queryable, now: string, deps: CycleDeps): Promise<CycleCounts> {
  const counts: CycleCounts = { renewalInvoices: 0, pastDue: 0, expired: 0, ended: 0, remindersSent: 0, remindersSkipped: 0 };
  const subs = await db.query(`SELECT ${SUB_COLS} FROM subscription WHERE status IN ('active','past_due') ORDER BY ends_at LIMIT 1000`);
  for (const row of subs.rows) {
    const sub = toSubscription(row);
    await atomic(db, async tx => {
      const open = await tx.query("SELECT 1 FROM invoice WHERE subscription_id = $1 AND status = 'pending' LIMIT 1", [sub.id]);
      const action = subscriptionAction(sub, now, open.rows.length > 0);
      if (action === "issue_renewal_invoice") {
        const plan = SUBSCRIPTION_PLANS.find(p => p.id === sub.planId);
        const inv = createSubscriptionInvoice(randomUUID(), sub.ownerUserId, sub.id, sub.planId, sub.priceSnapshotCents,
          `${plan?.name ?? sub.planId} plan, renewal`, addDays(sub.endsAt > now ? sub.endsAt : now, 0));
        await insertSubscriptionInvoice(tx, inv);
        await audit(tx, "system", "billing-run", "subscription", sub.id, "subscription.renewal_invoiced", { invoiceId: inv.id });
        counts.renewalInvoices++;
      } else if (action === "mark_past_due") {
        await tx.query("UPDATE subscription SET status = 'past_due' WHERE id = $1 AND status = 'active'", [sub.id]);
        counts.pastDue++;
      } else if (action === "expire") {
        await tx.query("UPDATE subscription SET status = 'expired' WHERE id = $1", [sub.id]);
        await tx.query("UPDATE invoice SET status = 'void' WHERE subscription_id = $1 AND status = 'pending'", [sub.id]);
        await audit(tx, "system", "billing-run", "subscription", sub.id, "subscription.expired", {});
        counts.expired++;
      } else if (action === "end_cancelled") {
        await tx.query("UPDATE subscription SET status = 'cancelled' WHERE id = $1", [sub.id]);
        await audit(tx, "system", "billing-run", "subscription", sub.id, "subscription.ended", {});
        counts.ended++;
      }
    });
  }
  await sendReminders(db, now, deps, counts);
  return counts;
}

async function sendReminders(db: Queryable, now: string, deps: CycleDeps, counts: CycleCounts): Promise<void> {
  // Unpaid invoices that are due within 3 days or already past due. The recipient is the invoice owner's own email.
  const res = await db.query(
    `SELECT ${INVOICE_COLS.split(", ").map(c => `i.${c}`).join(", ")}, u.email,
            COALESCE((SELECT array_agg(r.stage) FROM billing_reminder r WHERE r.invoice_id = i.id), '{}') AS sent
       FROM invoice i JOIN app_user u ON u.id = i.owner_user_id
      WHERE i.status = 'pending' AND i.due_at IS NOT NULL AND i.due_at <= $1::timestamptz + interval '3 days' AND u.status = 'active'
      ORDER BY i.due_at LIMIT 500`, [now]);
  for (const row of res.rows) {
    const inv = toInvoice(row);
    const sent = new Set((Array.isArray(row["sent"]) ? row["sent"] : []).map(String)) as Set<ReminderStage>;
    const stage = reminderToSend(inv, now, sent);
    const to = typeof row["email"] === "string" ? row["email"] : "";
    if (!stage || !to) continue;
    if (!deps.email.configured) { counts.remindersSkipped++; continue; }
    const msg = reminderEmail(stage, inv, deps.siteName, `${deps.baseUrl}/billing`);
    const r = await deps.email.send({ to, subject: msg.subject, text: msg.text });
    if (r.status !== "sent") { counts.remindersSkipped++; continue; }
    await atomic(db, async tx => {
      const ins = await tx.query("INSERT INTO billing_reminder (invoice_id, stage) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id", [inv.id, stage]);
      if (ins.rows.length > 0) await tx.query("UPDATE invoice SET reminders_sent = reminders_sent + 1, last_reminder_at = now() WHERE id = $1", [inv.id]);
    });
    counts.remindersSent++;
  }
}
