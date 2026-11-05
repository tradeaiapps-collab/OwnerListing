/** Webhook event names. No Node imports, so pages can use them. */
export const WEBHOOK_EVENTS = ["listing.published", "offer.submitted", "message.created", "appointment.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
