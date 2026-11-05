import type { CheckoutPort } from "../domain/listing-video";

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

/** Maps the Stripe events this feature needs; any other event type is acknowledged and ignored (undefined), a bad body is null. */
export function parseCheckoutEvent(rawBody: string): { eventId: string; kind: "paid" | "expired"; sessionId: string } | undefined | null {
  let b: unknown;
  try { b = JSON.parse(rawBody); } catch { return null; }
  const o = b as { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } } | null;
  if (!o || typeof o.id !== "string" || typeof o.type !== "string") return null;
  const obj = o.data?.object;
  if (!obj || typeof obj["id"] !== "string") return undefined;
  if (o.type === "checkout.session.completed" && obj["payment_status"] === "paid") return { eventId: o.id, kind: "paid", sessionId: obj["id"] };
  if (o.type === "checkout.session.expired") return { eventId: o.id, kind: "expired", sessionId: obj["id"] };
  return undefined;
}
