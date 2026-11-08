/** API scopes. No Node imports, so pages can use them. */
export const API_SCOPES = ["listings.read", "offers.read", "webhooks.manage"] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "listings.read": "Read published listings and your own listings.",
  "offers.read": "Read offers made on your listings (status and price only).",
  "webhooks.manage": "Create and delete webhook endpoints."
};
