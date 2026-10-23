export const GST_RATE_PERCENT = 10;

export function gstCents(exGstCents: number): number {
  if (!Number.isInteger(exGstCents) || exGstCents < 0) throw new Error("Amount must be a whole number of cents, zero or more.");
  return Math.round((exGstCents * GST_RATE_PERCENT) / 100);
}

export interface Invoice {
  id: string;
  ownerUserId: string;
  amountExGstCents: number;
  gstCents: number;
  totalCents: number;
  status: "pending" | "paid" | "failed";
  providerRef?: string;
  /** Set when the invoice is the flat fee for one listing's package (chosen and priced by the admin). */
  listingId?: string;
  planId?: string;
}

export function createInvoice(
  id: string, ownerUserId: string, amountExGstCents: number, forListing?: { listingId: string; planId: string }
): Invoice {
  const gst = gstCents(amountExGstCents);
  const base: Invoice = { id, ownerUserId, amountExGstCents, gstCents: gst, totalCents: amountExGstCents + gst, status: "pending" };
  return forListing ? { ...base, ...forListing } : base;
}

/** True only when a paid invoice for this exact listing, owned by this owner, exists. Feeds decidePublish. */
export function isListingFeePaid(invoices: readonly Invoice[], listingId: string, ownerUserId: string): boolean {
  return invoices.some((i) => i.listingId === listingId && i.ownerUserId === ownerUserId && i.status === "paid");
}

export interface PaymentEvent {
  /** The provider's unique event id. Used so a repeated webhook is applied only once. */
  eventId: string;
  invoiceId: string;
  amountCents: number;
  outcome: "succeeded" | "failed";
  providerRef: string;
}

/**
 * Applies a verified payment event. Repeats are ignored, an amount that does not match the
 * invoice is rejected (the caller flags it to an admin), and a paid invoice never changes.
 */
export function applyPaymentEvent(
  invoice: Invoice, e: PaymentEvent, processedEventIds: ReadonlySet<string>
): { invoice: Invoice; note: string } {
  if (processedEventIds.has(e.eventId)) return { invoice, note: "Duplicate event ignored." };
  if (e.invoiceId !== invoice.id) throw new Error("Event is for a different invoice.");
  if (invoice.status === "paid") return { invoice, note: "Invoice already paid; event ignored." };
  if (e.outcome === "succeeded") {
    if (e.amountCents !== invoice.totalCents) throw new Error("Paid amount does not match the invoice.");
    return { invoice: { ...invoice, status: "paid", providerRef: e.providerRef }, note: "Paid." };
  }
  return { invoice: { ...invoice, status: "failed", providerRef: e.providerRef }, note: "Payment failed." };
}

/**
 * What any payment provider (Westpac PayWay or another) must offer. Customers pay on the provider's
 * hosted page, so card numbers never reach our servers. Webhooks must be signature-checked.
 */
export interface PaymentProvider {
  createHostedCheckout(invoice: Invoice, returnUrl: string): Promise<{ redirectUrl: string }>;
  /** Returns null if the signature is invalid. */
  verifyAndParseWebhook(rawBody: string, headers: Readonly<Record<string, string>>): PaymentEvent | null;
}
