import { createHmac, timingSafeEqual } from "node:crypto";
import { applyPaymentEvent, type PaymentEvent } from "../domain/billing";
import type { BillingStore } from "../domain/billing-service";

export const SIGNATURE_HEADER = "x-payway-signature";
const MAX_BODY_BYTES = 64 * 1024;

/** Constant-time check of a hex HMAC-SHA256 of the raw body. Any malformed signature is simply invalid. */
export function signatureValid(rawBody: string, signatureHex: string | null, secret: string): boolean {
  if (!signatureHex || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signatureHex, "hex"));
}

const short = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

export function parseEvent(rawBody: string): PaymentEvent | null {
  let b: unknown;
  try { b = JSON.parse(rawBody); } catch { return null; }
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const amount = o["amountCents"];
  if (!short(o["eventId"]) || !short(o["invoiceId"]) || !short(o["providerRef"])) return null;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (o["outcome"] !== "succeeded" && o["outcome"] !== "failed") return null;
  return { eventId: o["eventId"], invoiceId: o["invoiceId"], amountCents: amount, outcome: o["outcome"], providerRef: o["providerRef"] };
}

export interface WebhookReply { status: number; body: Record<string, unknown> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handles a payment webhook. Rejects everything while the secret is unset or the signature is wrong. A verified event is
 * applied once (repeats are acknowledged and ignored); a payment that cannot be applied is never applied and opens an admin case.
 */
export async function handlePaymentWebhook(
  store: BillingStore, rawBody: string, signature: string | null, secret: string | undefined
): Promise<WebhookReply> {
  if (!secret) return { status: 503, body: { error: "Payment webhooks are not enabled." } };
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { status: 413, body: { error: "Too large." } };
  if (!signatureValid(rawBody, signature, secret)) return { status: 401, body: { error: "Invalid signature." } };
  const e = parseEvent(rawBody);
  if (!e) return { status: 400, body: { error: "Invalid event." } };
  if (await store.eventSeen(e.eventId)) return { status: 200, body: { ok: true, note: "Duplicate event ignored." } };
  const invoice = UUID.test(e.invoiceId) ? await store.getInvoice(e.invoiceId) : undefined;
  if (!invoice) return { status: 404, body: { error: "Unknown invoice." } };
  const reject = async (reason: string): Promise<WebhookReply> => {
    await store.flagMismatch(invoice, e, reason);
    return { status: 409, body: { error: "Payment cannot be applied to the invoice; an admin will review it." } };
  };
  if (invoice.status === "failed" && e.outcome === "succeeded") return reject("Payment arrived for an invoice that was replaced or failed.");
  let applied;
  try {
    applied = applyPaymentEvent(invoice, e, new Set());
  } catch (err) {
    return reject(err instanceof Error ? err.message : "Payment could not be applied.");
  }
  await store.settle(applied.invoice, e);
  return { status: 200, body: { ok: true, note: applied.note } };
}
