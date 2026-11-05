/**
 * White-label tenants: host-name rules and brand input validation. Pure functions (no framework, no database).
 * A tenant's look is a full ThemeSettings built from the platform defaults plus a few agency choices and then checked by validateTheme,
 * so the same hex, contrast and plain-text rules apply as on the platform site. Nothing here accepts raw CSS or HTML.
 */
import { DEFAULT_THEME, HEX_RE, LIMITS, validateTheme, type ThemeSettings } from "./site-theme";

export type TenantStatus = "draft" | "active" | "suspended";
export const TENANT_STATUSES: readonly TenantStatus[] = ["draft", "active", "suspended"];
export const MAX_DOMAINS_PER_TENANT = 5;
/** The DNS TXT record that proves control of a host: name `_wl-verify.<host>`, value `wl-verify=<token>`. */
export const VERIFY_PREFIX = "_wl-verify";
export const verifyRecordName = (host: string) => `${VERIFY_PREFIX}.${host}`;
export const verifyRecordValue = (token: string) => `wl-verify=${token}`;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
/** Hosts a tenant may never claim, whatever the DNS says. */
const RESERVED_SUFFIXES = ["localhost", "local", "internal", "invalid", "test", "example", "vercel.app"];

/** Lower-case host without port or trailing dot, or null when it is not a plain DNS name (IPs, ports with junk, paths and credentials are refused). */
export function normaliseHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let h = raw.trim().toLowerCase();
  if (h.length === 0 || h.length > 300) return null;
  if (/[\s/\\@?#]/.test(h)) return null;
  h = h.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (h.length > 253 || !HOST_RE.test(h)) return null;
  if (/^\d+(\.\d+)*$/.test(h)) return null;
  return h;
}

/** Why a tenant may not use this host, or null when it may. `platformHosts` are the platform's own hosts (from PLATFORM_HOSTS). */
export function hostProblem(host: string, platformHosts: readonly string[] = []): string | null {
  if (RESERVED_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`))) return "That domain belongs to the platform or is reserved.";
  if (platformHosts.some(p => host === p || host.endsWith(`.${p}`))) return "That domain belongs to the platform.";
  return null;
}

export const platformHostsFrom = (env: Record<string, string | undefined> = process.env): string[] =>
  (env["PLATFORM_HOSTS"] ?? "").split(",").map(s => normaliseHost(s)).filter((h): h is string => h !== null);

export interface BrandInput { name: string; tagline: string; primary: string; secondary: string; footerText: string }
export type BrandResult = { ok: true; settings: ThemeSettings; input: BrandInput } | { ok: false; errors: Record<string, string> };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Builds a tenant's settings from the few things an agency chooses. primary drives accent, link and the primary colour; secondary drives the
 * header text, headings and buttons. Reuses the platform contrast checks, so a colour that fails them is reported rather than silently changed.
 */
export function buildTenantSettings(raw: unknown): BrandResult {
  const errors: Record<string, string> = {};
  if (!isObj(raw)) return { ok: false, errors: { _: "Send the brand settings as an object." } };
  const text = (k: string, max: number, required: boolean): string => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") { if (required) errors[k] = "Required."; return ""; }
    if (typeof v !== "string") { errors[k] = "Must be text."; return ""; }
    const t = v.trim();
    if (t.length > max) errors[k] = `At most ${max} characters.`;
    return t;
  };
  const hex = (k: string): string => {
    const v = typeof raw[k] === "string" ? (raw[k] as string).trim().toLowerCase() : "";
    if (!HEX_RE.test(v)) errors[k] = "Use a 6-digit hex colour such as #1f3a5f.";
    return v;
  };
  const input: BrandInput = {
    name: text("name", LIMITS.siteName, true), tagline: text("tagline", LIMITS.tagline, false),
    primary: hex("primary"), secondary: hex("secondary"), footerText: text("footerText", LIMITS.footerText, false)
  };
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const s = structuredClone(DEFAULT_THEME);
  s.brand.siteName = input.name;
  s.brand.tagline = input.tagline || null;
  const c = s.colours.light;
  c.primary = c.accent = c.link = input.primary;
  c.secondary = c.heading = c.headerText = c.buttonBg = input.secondary;
  s.footer.text = input.footerText;
  const v = validateTheme(s);
  return v.ok ? { ok: true, settings: v.value, input } : { ok: false, errors: v.errors };
}

/** The brand fields an agency edits, read back from stored settings. */
export function brandInputOf(s: ThemeSettings): BrandInput {
  return { name: s.brand.siteName ?? "", tagline: s.brand.tagline ?? "", primary: s.colours.light.primary, secondary: s.colours.light.secondary, footerText: s.footer.text };
}

/** What the layout and asset route need about the tenant a request belongs to. */
export interface TenantView { id: string; settings: ThemeSettings; logoLightId: number | null; faviconId: number | null }

/** Public image route for the tenant that owns the request's host. The id is only a cache-busting version. */
export const tenantAssetUrl = (slot: "logo-light" | "favicon", id: number): string => `/api/tenant/asset/${slot}?v=${id}`;
