import { SUBSCRIPTION_PLANS, periodPriceCents, type BillingInterval } from "./plans";
import { addDays } from "./billing";

/**
 * Recurring plans for owners and agents. Billing works by invoice per period, so it runs the same way whether the customer pays on the
 * provider's hosted page or by bank transfer: a renewal invoice is issued shortly before the period ends, and paying it extends the
 * period. Nothing renews unless the invoice is paid, and card numbers never reach us. Pure functions; the database port is in
 * src/server/subscription-db.ts.
 */
export type SubscriptionStatus = "pending" | "active" | "past_due" | "expired" | "cancelled";

export interface SubscriptionRow {
  id: string;
  ownerUserId: string;
  planId: string;
  interval: BillingInterval;
  status: SubscriptionStatus;
  startsAt: string;
  endsAt: string;
  cancelAtPeriodEnd: boolean;
  /** Price for one period locked when the subscription was bought (cents excluding GST). */
  priceSnapshotCents: number;
}

/** Days before the period ends that the renewal invoice is issued. */
export const RENEWAL_LEAD_DAYS = 7;
/** Days after the period ends that a customer can still pay before the subscription expires. */
export const GRACE_DAYS = 7;

/** Adds whole calendar months in UTC, keeping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

export const addPeriod = (iso: string, interval: BillingInterval): string => addMonths(iso, interval === "yearly" ? 12 : 1);

export function planAllowedFor(userType: string, planId: string): boolean {
  const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
  return !!plan && plan.audience === userType;
}

/** The period price for a new subscription, or null when the plan is unknown or has no admin-set price yet. */
export function periodQuote(planId: string, interval: BillingInterval, monthlyPrices: Readonly<Record<string, number>>): number | null {
  if (!SUBSCRIPTION_PLANS.some(p => p.id === planId)) return null;
  const monthly = monthlyPrices[planId];
  return monthly === undefined ? null : periodPriceCents(monthly, interval);
}

/**
 * What the subscription is after a period invoice is paid at `paidAt`. A first payment starts the period at `paidAt`. A renewal continues
 * from the old end (or from `paidAt` if it was paid late), so paying early never loses days. Returns null for an expired or cancelled
 * subscription: a late payment must not bring it back, so the caller opens an admin case instead.
 */
export function afterPeriodPaid(sub: SubscriptionRow, paidAt: string): SubscriptionRow | null {
  if (sub.status === "expired" || sub.status === "cancelled") return null;
  if (sub.status === "pending") return { ...sub, status: "active", startsAt: paidAt, endsAt: addPeriod(paidAt, sub.interval) };
  const from = sub.endsAt > paidAt ? sub.endsAt : paidAt;
  return { ...sub, status: "active", endsAt: addPeriod(from, sub.interval) };
}

export type SubscriptionAction = "issue_renewal_invoice" | "mark_past_due" | "expire" | "end_cancelled" | "none";

/**
 * What the daily billing run should do with one subscription.
 * - A subscription set to cancel at period end ends when the period does and is never invoiced again.
 * - Otherwise a renewal invoice is issued RENEWAL_LEAD_DAYS before the end (once: `hasOpenInvoice`).
 * - Past the end and unpaid it becomes past due, and after GRACE_DAYS it expires.
 */
export function subscriptionAction(sub: SubscriptionRow, now: string, hasOpenInvoice: boolean): SubscriptionAction {
  if (sub.status === "pending" || sub.status === "expired" || sub.status === "cancelled") return "none";
  if (sub.cancelAtPeriodEnd) return sub.endsAt <= now ? "end_cancelled" : "none";
  if (sub.endsAt <= addDays(now, -GRACE_DAYS)) return "expire";
  if (sub.endsAt <= now) return sub.status === "active" ? "mark_past_due" : hasOpenInvoice ? "none" : "issue_renewal_invoice";
  if (sub.endsAt <= addDays(now, RENEWAL_LEAD_DAYS) && !hasOpenInvoice) return "issue_renewal_invoice";
  return "none";
}

/** True when the subscription currently gives its plan's features. */
export const isEntitled = (sub: SubscriptionRow | undefined, now: string): boolean =>
  !!sub && (sub.status === "active" || sub.status === "past_due") && sub.endsAt > addDays(now, -GRACE_DAYS);
