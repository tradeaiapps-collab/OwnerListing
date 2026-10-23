import type { PaymentProvider } from "../domain/billing";

export interface PaywayConfig { merchantId: string; apiKey: string; webhookSecret: string }

/** Settings come from the environment, never from code. Missing settings stop the app starting. */
export function paywayConfigFromEnv(env: Readonly<Record<string, string | undefined>>): PaywayConfig {
  const merchantId = env.PAYWAY_MERCHANT_ID, apiKey = env.PAYWAY_API_KEY, webhookSecret = env.PAYWAY_WEBHOOK_SECRET;
  if (!merchantId || !apiKey || !webhookSecret) throw new Error("Westpac PayWay settings are missing.");
  return { merchantId, apiKey, webhookSecret };
}

/**
 * Westpac PayWay (the bank's payment service). Customers pay on Westpac's hosted page, so card numbers never reach us.
 * Until the merchant account is approved and the PayWay documentation is in hand, this fails closed:
 * no checkout can start and every webhook is rejected, so nothing can be marked paid by mistake.
 */
export function createWestpacPayway(_config: PaywayConfig): PaymentProvider {
  return {
    async createHostedCheckout() { throw new Error("Westpac PayWay is not connected yet."); },
    verifyAndParseWebhook() { return null; }
  };
}
