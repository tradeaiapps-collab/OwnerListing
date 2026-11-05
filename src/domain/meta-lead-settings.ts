import type { MetaConfig } from "../adapters/ad-lead-providers";

/**
 * Facebook / Instagram lead ads connection, entered by an admin at /staff/meta-leads. Pure: field list, validation and how stored values
 * and environment variables combine (an environment variable wins per field). The OAuth sign-in on Meta's side is not part of this.
 */
export const META_FIELDS = ["appId", "appSecret", "verifyToken", "pageToken"] as const;
export type MetaField = (typeof META_FIELDS)[number];
/** Write-only: never returned, only reported as set or not set. */
export const META_SECRET_FIELDS: readonly MetaField[] = ["appSecret", "verifyToken", "pageToken"];
export const isMetaSecret = (f: MetaField): boolean => META_SECRET_FIELDS.includes(f);
export const isMetaField = (v: unknown): v is MetaField => typeof v === "string" && (META_FIELDS as readonly string[]).includes(v);
/** Needed for the webhook to work; appId is optional and only lets "Test connection" check the app secret. */
export const META_REQUIRED: readonly MetaField[] = ["appSecret", "verifyToken", "pageToken"];

export const META_ENV_NAMES: Record<MetaField, string> = { appId: "META_APP_ID", appSecret: "META_APP_SECRET", verifyToken: "META_WEBHOOK_VERIFY_TOKEN", pageToken: "META_PAGE_ACCESS_TOKEN" };
export const META_FIELD_LABELS: Record<MetaField, string> = { appId: "App ID", appSecret: "App secret", verifyToken: "Webhook verify token", pageToken: "Page access token" };
export const META_WEBHOOK_PATH = "/api/webhooks/ad-leads/meta";

/** "Test connection" is limited per staff member (a refused attempt still counts). */
export const META_TEST_RATE = { windowMs: 60 * 60 * 1000, perStaff: 10, allStaff: 30 } as const;

const PRINTABLE = /^[\x21-\x7e]+$/;

/** The cleaned value, or an error message. The empty string is handled by the caller (it clears the setting). */
export function validateMetaField(field: MetaField, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Must be text." };
  const v = raw.trim();
  const bad = (error: string) => ({ ok: false as const, error });
  switch (field) {
    case "appId": return /^\d{5,20}$/.test(v) ? { ok: true, value: v } : bad("App ID is the number shown at the top of your Meta app dashboard (digits only).");
    case "appSecret": return PRINTABLE.test(v) && v.length >= 16 && v.length <= 128 ? { ok: true, value: v } : bad("App secret must be 16 to 128 characters with no spaces.");
    case "verifyToken": return PRINTABLE.test(v) && v.length >= 16 && v.length <= 128 ? { ok: true, value: v } : bad("Verify token must be 16 to 128 characters with no spaces. Use Generate if unsure.");
    case "pageToken": return PRINTABLE.test(v) && v.length >= 20 && v.length <= 1024 ? { ok: true, value: v } : bad("Page access token must be 20 to 1024 characters with no spaces.");
  }
}

type Env = Readonly<Record<string, string | undefined>>;

/** Environment value (if set and valid) wins over the stored value (if valid). Invalid values count as not set. */
export function pickMeta(field: MetaField, stored: Partial<Record<MetaField, string>>, env: Env): { value: string; source: "env" | "database" } | undefined {
  const e = env[META_ENV_NAMES[field]];
  if (e !== undefined && e.trim() !== "") {
    const r = validateMetaField(field, e);
    return r.ok ? { value: r.value, source: "env" } : undefined;
  }
  const s = stored[field];
  if (s !== undefined && s !== "") {
    const r = validateMetaField(field, s);
    return r.ok ? { value: r.value, source: "database" } : undefined;
  }
  return undefined;
}

/** All three required settings or null: the Meta lead webhook stays off (503) until the connection is complete. */
export function resolveMeta(stored: Partial<Record<MetaField, string>>, env: Env): (MetaConfig & { appId?: string }) | null {
  const g = (f: MetaField) => pickMeta(f, stored, env)?.value;
  const appSecret = g("appSecret"), verifyToken = g("verifyToken"), pageToken = g("pageToken"), appId = g("appId");
  return appSecret && verifyToken && pageToken ? { appSecret, verifyToken, pageToken, ...(appId ? { appId } : {}) } : null;
}

/** Key for sealing the secrets: INTEGRATION_SETTINGS_KEY if set, otherwise the existing MESSAGING_SETTINGS_KEY (32 bytes, base64). */
export const metaSettingsKey = (env: Env): string | undefined => (env["INTEGRATION_SETTINGS_KEY"]?.trim() ? env["INTEGRATION_SETTINGS_KEY"] : env["MESSAGING_SETTINGS_KEY"]);

export type MetaStatus = "connected" | "untested" | "test_failed" | "disconnected";
export interface MetaTestResult { at: string; ok: boolean; message: string; pageName: string | null; pageId: string | null; appChecked: boolean }

/** connected = complete and the last test passed since the last change; untested/test_failed = complete; disconnected = incomplete. */
export function metaStatus(configured: boolean, test: MetaTestResult | null): MetaStatus {
  if (!configured) return "disconnected";
  if (!test) return "untested";
  return test.ok ? "connected" : "test_failed";
}
