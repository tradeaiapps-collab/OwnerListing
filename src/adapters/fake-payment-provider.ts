import { createHmac } from "node:crypto";
import type { PaymentProvider } from "../domain/billing";
import { parseEvent, signatureValid, SIGNATURE_HEADER } from "../server/payment-webhook";

/**
 * Test-only payment provider. It never talks to a network and refuses to be created in production,
 * so it cannot mark anything paid in a live environment. It signs and verifies webhooks the same way as the real handler.
 */
export function createFakePaymentProvider(secret: string, env: Readonly<Record<string, string | undefined>> = process.env): PaymentProvider & {
  /** Builds a valid signature header for a test webhook body. */
  sign(rawBody: string): Record<string, string>;
} {
  if (env["NODE_ENV"] === "production") throw new Error("The fake payment provider cannot be used in production.");
  if (!secret) throw new Error("A webhook secret is required.");
  return {
    async createHostedCheckout(invoice) { return { redirectUrl: `https://payments.invalid/checkout/${encodeURIComponent(invoice.id)}` }; },
    verifyAndParseWebhook(rawBody, headers) {
      return signatureValid(rawBody, headers[SIGNATURE_HEADER] ?? null, secret) ? parseEvent(rawBody) : null;
    },
    sign(rawBody) { return { [SIGNATURE_HEADER]: createHmac("sha256", secret).update(rawBody).digest("hex") }; }
  };
}
