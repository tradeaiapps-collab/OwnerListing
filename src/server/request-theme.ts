import { cache } from "react";
import { headers } from "next/headers";
import { resolveTheme, type ResolvedTheme } from "./site-theme";
import { requestHost, tenantForHost } from "./white-label";

/**
 * Theme for the current request. A request on an active white-label agency's verified domain gets that agency's brand; every other host gets
 * the platform theme (published, or the draft when a valid preview token came with it). Computed once per request.
 */
export const getRequestTheme = cache(async (): Promise<ResolvedTheme> => {
  const h = await headers();
  const tenant = await tenantForHost(requestHost(h));
  if (tenant) return { settings: tenant.settings, version: null, source: "tenant", previewToken: null, tenantId: tenant.id };
  return resolveTheme(h.get("x-theme-preview"));
});
