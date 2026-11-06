import { DEFAULT_LOCALE, LOCALES } from "./i18n";
import type { Failure, Result } from "./listing-service";
import { isValidTimeZone } from "./timezone";

export interface AccountSettings { locale: string; timeZone: string }

export const DEFAULT_SETTINGS: AccountSettings = { locale: DEFAULT_LOCALE, timeZone: "Australia/Sydney" };

/** Zones offered on the settings page. Any valid IANA zone is accepted by the API. */
export const TIME_ZONE_CHOICES: readonly string[] = [
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide",
  "Australia/Perth", "Australia/Darwin", "Australia/Hobart", "Pacific/Auckland", "UTC"
];

const bad = (message: string): Failure => ({ ok: false, code: "invalid", message });
/** Region/City names only. Rejects offsets such as "+05:00", which Intl would otherwise accept. */
const IANA_SHAPE = /^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/;

/** Body: { locale, timeZone }. Both required, nothing else allowed. */
export function parseSettingsInput(body: unknown): Result<AccountSettings> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Send a JSON object.");
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find(k => k !== "locale" && k !== "timeZone");
  if (extra !== undefined) return bad(`Unsupported field: ${extra}.`);
  const locale = b["locale"];
  if (typeof locale !== "string" || !LOCALES.some(l => l.code === locale)) return bad("Choose a supported language.");
  const tz = b["timeZone"];
  if (typeof tz !== "string" || tz.length > 64 || !IANA_SHAPE.test(tz) || !isValidTimeZone(tz)) return bad("Choose a valid time zone.");
  return { ok: true, value: { locale, timeZone: tz } };
}

/** Cookie that carries the saved language to the server-rendered page, so <html lang> and direction follow the setting. */
export const LOCALE_COOKIE = "ol_locale";
