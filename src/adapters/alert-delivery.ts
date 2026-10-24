import type { AlertDeliveryPort, AlertMessage } from "../domain/alerts";

/** No email or SMS provider is chosen yet. This port fails closed: it never sends and says so. */
export function createUnconfiguredAlertDelivery(): AlertDeliveryPort {
  return { async send() { return "not_configured"; } };
}

/** Test double: records each message and reports "sent". Never use outside tests and local development. */
export function createRecordingAlertDelivery(sink: AlertMessage[] = []): AlertDeliveryPort & { readonly sent: AlertMessage[] } {
  return { sent: sink, async send(msg) { sink.push(msg); return "sent"; } };
}

/**
 * Development adapter: writes one line per alert and sends nothing. The line has ids only (channel, listing, search),
 * never an address, number, name or unsubscribe link.
 */
export function createConsoleAlertDelivery(write: (line: string) => void = line => console.log(line)): AlertDeliveryPort {
  return { async send(msg) { write(`[alert:dev] channel=${msg.channel} listing=${msg.listingId} search=${msg.searchId}`); return "sent"; } };
}

/**
 * Chooses the adapter from the environment. Fails closed: anything unknown, or "console" in production, is unconfigured.
 * Add the real provider here once one is chosen (it must also refuse to send when its own settings are missing).
 */
export function alertDeliveryFromEnv(env: Readonly<Record<string, string | undefined>>): AlertDeliveryPort {
  if (env["ALERT_DELIVERY"] === "console" && env["NODE_ENV"] !== "production") return createConsoleAlertDelivery();
  return createUnconfiguredAlertDelivery();
}
