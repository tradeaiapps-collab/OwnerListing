import { mapMetaLead, type LeadInput, type MetaLeadRef } from "../domain/lead-ads";

/**
 * Fetching one lead from Meta's Graph API. Meta's webhook only carries the lead's id; the answers are read with the Page access token.
 * Timeout, no redirects, and errors are short key-free messages (the token and Meta's response body are never put in them).
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export const META_GRAPH_VERSION = "v21.0";
export interface MetaConfig { appSecret: string; verifyToken: string; pageToken: string }

/** All three Meta settings or none: the connector stays off until the agency's app is fully set up. */
export function metaConfig(env: Readonly<Record<string, string | undefined>>): MetaConfig | null {
  const appSecret = env["META_APP_SECRET"]?.trim(), verifyToken = env["META_WEBHOOK_VERIFY_TOKEN"]?.trim(), pageToken = env["META_PAGE_ACCESS_TOKEN"]?.trim();
  return appSecret && verifyToken && pageToken ? { appSecret, verifyToken, pageToken } : null;
}

export async function fetchMetaLead(fetchFn: FetchFn, ref: MetaLeadRef, cfg: MetaConfig): Promise<{ lead: LeadInput } | { error: string }> {
  let res: Response;
  try {
    res = await fetchFn(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(ref.leadgenId)}?fields=id,ad_id,ad_name,campaign_id,campaign_name,form_id,field_data,created_time`, {
      headers: { authorization: `Bearer ${cfg.pageToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000)
    });
  } catch (e) {
    return { error: (e as Error)?.name === "TimeoutError" ? "Meta did not answer in time." : "Could not reach Meta." };
  }
  if (res.status === 401 || res.status === 403) return { error: "Meta refused the Page access token." };
  if (!res.ok) return { error: `Meta answered ${res.status}.` };
  const body = (await res.json().catch(() => null)) as unknown;
  const mapped = mapMetaLead(body, ref);
  return mapped.ok ? { lead: mapped.value } : { error: mapped.error };
}
