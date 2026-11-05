import { mapMetaLead, type LeadInput, type MetaLeadRef } from "../domain/ad-leads";

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

export interface MetaTestOutcome { ok: boolean; message: string; pageId: string | null; pageName: string | null; appChecked: boolean }

/**
 * "Test connection": reads the Page the token belongs to (/me) and, when the App ID is known, asks Meta to accept the app ID with the app secret.
 * Credentials go in the Authorization header, never in a URL. Messages are short and key-free; Meta's response body is never passed on.
 */
export async function testMetaConnection(fetchFn: FetchFn, cfg: MetaConfig & { appId?: string }): Promise<MetaTestOutcome> {
  const get = async (path: string, bearer: string): Promise<{ status: number; body: Record<string, unknown> | null } | { error: string }> => {
    try {
      const res = await fetchFn(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`, { headers: { authorization: `Bearer ${bearer}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: res.status, body: body && typeof body === "object" ? body : null };
    } catch (e) {
      return { error: (e as Error)?.name === "TimeoutError" ? "Meta did not answer in time." : "Could not reach Meta." };
    }
  };
  const fail = (message: string): MetaTestOutcome => ({ ok: false, message, pageId: null, pageName: null, appChecked: false });
  const page = await get("me?fields=id,name", cfg.pageToken);
  if ("error" in page) return fail(page.error);
  if (page.status === 400 || page.status === 401 || page.status === 403) return fail("Meta refused the Page access token. It may be wrong, expired or revoked.");
  if (page.status !== 200 || typeof page.body?.["id"] !== "string") return fail(`Meta answered ${page.status}.`);
  const pageId = String(page.body["id"]).slice(0, 64), pageName = typeof page.body["name"] === "string" ? String(page.body["name"]).slice(0, 200) : null;
  if (!cfg.appId) return { ok: true, message: "The Page access token works. Add the App ID to also check the app secret.", pageId, pageName, appChecked: false };
  const app = await get(`${encodeURIComponent(cfg.appId)}?fields=id`, `${cfg.appId}|${cfg.appSecret}`);
  if ("error" in app) return { ok: false, message: app.error, pageId, pageName, appChecked: false };
  if (app.status !== 200 || String(app.body?.["id"]) !== cfg.appId) return { ok: false, message: "Meta did not accept the App ID and app secret together.", pageId, pageName, appChecked: false };
  return { ok: true, message: "The Page access token and the app secret both work.", pageId, pageName, appChecked: true };
}
