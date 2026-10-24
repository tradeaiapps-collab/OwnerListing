import { createInvoice, type Invoice, type PaymentEvent } from "./billing";
import { DEFAULT_PLANS, quote, withPrices, type PlanDef } from "./plans";

export interface PriceRow { id: string; planId: string; priceCents: number; reason: string; setBy: string; effectiveFrom: string }

/** Storage port for billing. The PostgreSQL version is in src/server/billing-db.ts. */
export interface BillingStore {
  /** Owner of a listing, or undefined when there is no such listing. */
  listingOwner(listingId: string): Promise<string | undefined>;
  /** Latest admin-set price per plan id, in cents excluding GST. */
  currentPrices(): Promise<Record<string, number>>;
  priceHistory(): Promise<PriceRow[]>;
  addPrice(row: { planId: string; priceCents: number; reason: string; setBy: string }): Promise<void>;
  invoicesForListing(listingId: string): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | undefined>;
  /** Marks the pending invoices failed (replaced by a new choice) and inserts the new one. */
  replaceInvoices(supersedeIds: readonly string[], invoice: Invoice): Promise<void>;
  eventSeen(eventId: string): Promise<boolean>;
  /** Stores the outcome: updates the invoice, sets listing_fee_paid when paid, records the event. */
  settle(invoice: Invoice, e: PaymentEvent): Promise<void>;
  /** Records the event and opens an admin case for a payment that cannot be applied. */
  flagMismatch(invoice: Invoice, e: PaymentEvent, reason: string): Promise<void>;
}

export async function pricedPlans(store: BillingStore): Promise<PlanDef[]> {
  return withPrices(DEFAULT_PLANS, await store.currentPrices());
}

export const PRICE_MAX_CENTS = 100_000_000;

export type PriceInput = { planId: string; priceCents: number; reason: string };

export function parsePriceInput(body: unknown): { ok: true; value: PriceInput } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const planId = typeof b["planId"] === "string" ? b["planId"] : "";
  if (!DEFAULT_PLANS.some(p => p.id === planId)) return { ok: false, error: "Choose a plan." };
  const cents = b["priceCents"];
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents < 1 || cents > PRICE_MAX_CENTS) {
    return { ok: false, error: "Price must be a whole number of cents, at least 1 and at most 100,000,000." };
  }
  const reason = typeof b["reason"] === "string" ? b["reason"].trim() : "";
  if (reason.length < 5 || reason.length > 500) return { ok: false, error: "A reason of 5 to 500 characters is required." };
  return { ok: true, value: { planId, priceCents: cents, reason } };
}

export type CheckoutResult =
  | { ok: true; invoice: Invoice }
  | { ok: false; code: "invalid" | "not_found"; message: string };

/**
 * Creates (or finds) the invoice for one listing's plan. Only the listing's owner can do this, and a plan without an
 * admin-set price cannot be bought. Idempotent: a paid invoice, or a pending one for the same plan, is returned as it is,
 * so a later price change never alters the price already invoiced. Choosing another plan replaces the pending invoice.
 */
export async function startCheckout(
  store: BillingStore, ownerUserId: string, listingId: string, planId: string, newId: () => string
): Promise<CheckoutResult> {
  const owner = await store.listingOwner(listingId);
  if (owner === undefined || owner !== ownerUserId) return { ok: false, code: "not_found", message: "Listing not found." };
  const plan = (await pricedPlans(store)).find(p => p.id === planId);
  if (!plan) return { ok: false, code: "invalid", message: "Choose a plan." };
  const existing = await store.invoicesForListing(listingId);
  const paid = existing.find(i => i.status === "paid");
  if (paid) return { ok: true, invoice: paid };
  const pending = existing.filter(i => i.status === "pending");
  const same = pending.find(i => i.planId === plan.id);
  if (same) return { ok: true, invoice: same };
  const q = quote(plan, [], {});
  if (!q.ok) return { ok: false, code: "invalid", message: "This plan's price has not been set, so it cannot be bought yet." };
  const invoice = createInvoice(newId(), ownerUserId, q.totalCents, { listingId, planId: plan.id });
  await store.replaceInvoices(pending.map(i => i.id), invoice);
  return { ok: true, invoice };
}
