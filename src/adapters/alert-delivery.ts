import type { AlertDeliveryPort } from "../domain/alerts";

/** No email or SMS provider is chosen yet. This port fails closed: it never sends and says so. */
export function createUnconfiguredAlertDelivery(): AlertDeliveryPort {
  return { async send() { return "not_configured"; } };
}
