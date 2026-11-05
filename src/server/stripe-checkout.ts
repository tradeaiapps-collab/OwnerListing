import { RefundError, type CheckoutPort, type RefundPort } from "../domain/listing-video";

// Hosted Stripe Checkout for the one-off buyer video payment. Stripe collects the card, so no card number touches this server.
// Off unless VIDEO_PAYMENTS_ENABLED=1 and a key is set. A live key (sk_live_) is refused unless VIDEO_PAYMENTS_ALLOW_LIVE=1:
// project rule, no live payment keys until the pen test and counsel sign-off.

type Env = Readonly<Record<string, string | undefined>>;
const API = "https://api.stripe.com/v1";

export function videoPaymentsEnabled(env: Env): boolean {
  const key = env["STRIPE_SECRET_KEY"] ?? "";
  if (env["VIDEO_PAYMENTS_ENABLED"] !== "1" || !/^sk_(test|live)_[A-Za-z0-9]{8,}$/.test(key)) return false;
  return key.startsWith("sk_test_") || env["VIDEO_PAYMENTS_ALLOW_LIVE"] === "1";
}

export function stripeCheckoutFromEnv(env: Env = process.env, fetchImpl: typeof fetch = fetch): CheckoutPort {
  return {
    enabled: videoPaymentsEnabled(env),
    async createCheckout(i) {
      const form: Record<string, string> = {
        mode: "payment", success_url: i.successUrl, cancel_url: i.cancelUrl, client_reference_id: i.purchaseId,
        "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "aud",
        "line_items[0][price_data][unit_amount]": String(i.amountCents), "line_items[0][price_data][product_data][name]": i.description,
        "metadata[purchaseId]": i.purchaseId, "payment_intent_data[metadata][purchaseId]": i.purchaseId
      };
      if (i.buyerEmail) form["customer_email"] = i.buyerEmail;
      const res = await fetchImpl(`${API}/checkout/sessions`, {
        method: "POST", signal: AbortSignal.timeout(15_000), body: new URLSearchParams(form).toString(),
        headers: { authorization: `Bearer ${env["STRIPE_SECRET_KEY"]}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": `video-${i.purchaseId}` }
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || typeof body["id"] !== "string" || typeof body["url"] !== "string") throw new Error(`Stripe ${res.status}`);
      return { sessionId: body["id"], url: body["url"] };
    }
  };
}

/** Refunds the full payment of a failed video. Same gate as checkout: test key (or explicitly allowed live key) and VIDEO_PAYMENTS_ENABLED=1. */
export function stripeRefundsFromEnv(env: Env = process.env, fetchImpl: typeof fetch = fetch): RefundPort {
  return {
    enabled: videoPaymentsEnabled(env),
    async refund(i) {
      const res = await fetchImpl(`${API}/refunds`, {
        method: "POST", signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({ payment_intent: i.paymentIntentId, amount: String(i.amountCents), reason: "requested_by_customer", "metadata[videoRefundId]": i.refundId }).toString(),
        headers: { authorization: `Bearer ${env["STRIPE_SECRET_KEY"]}`, "content-type": "application/x-www-form-urlencoded", "idempotency-key": i.idempotencyKey }
      }).catch(() => null);
      if (!res) throw new RefundError("Could not reach Stripe.", false);
      const body = (await res.json().catch(() => ({}))) as { id?: unknown; error?: { code?: unknown } };
      if (res.ok && typeof body.id === "string") return { stripeRefundId: body.id };
      // The charge is already fully refunded (for example by hand in the Stripe dashboard): the buyer has their money, record it as done.
      if (body.error?.code === "charge_already_refunded") return { stripeRefundId: "already_refunded" };
      // 4xx other than rate limit / lock timeout will not change on a retry; 429 and 5xx will.
      throw new RefundError(`Stripe ${res.status}${typeof body.error?.code === "string" ? ` ${body.error.code}`.slice(0, 60) : ""}`, res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 409);
    }
  };
}

/** Maps the Stripe events this feature needs; any other event type is acknowledged and ignored (undefined), a bad body is null. */
export function parseCheckoutEvent(rawBody: string): { eventId: string; kind: "paid" | "expired"; sessionId: string; paymentIntentId?: string } | undefined | null {
  let b: unknown;
  try { b = JSON.parse(rawBody); } catch { return null; }
  const o = b as { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } } | null;
  if (!o || typeof o.id !== "string" || typeof o.type !== "string") return null;
  const obj = o.data?.object;
  if (!obj || typeof obj["id"] !== "string") return undefined;
  if (o.type === "checkout.session.completed" && obj["payment_status"] === "paid") return { eventId: o.id, kind: "paid", sessionId: obj["id"], ...(typeof obj["payment_intent"] === "string" ? { paymentIntentId: obj["payment_intent"] } : {}) };
  if (o.type === "checkout.session.expired") return { eventId: o.id, kind: "expired", sessionId: obj["id"] };
  return undefined;
}
