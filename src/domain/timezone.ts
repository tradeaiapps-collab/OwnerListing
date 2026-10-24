import type { Jurisdiction } from "./jurisdiction";

/** Store every timestamp in UTC. Show it in the viewer's zone. Measure legal deadlines in the property's state zone. */
export const JURISDICTION_TIME_ZONE: Record<Jurisdiction, string> = {
  NSW: "Australia/Sydney", VIC: "Australia/Melbourne", QLD: "Australia/Brisbane", WA: "Australia/Perth",
  SA: "Australia/Adelaide", TAS: "Australia/Hobart", ACT: "Australia/Sydney", NT: "Australia/Darwin"
};

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

export function resolveTimeZone(userTz: string | undefined, fallback: string): string {
  return userTz !== undefined && isValidTimeZone(userTz) ? userTz : fallback;
}

export function formatInZone(iso: string, timeZone: string, locale = "en-AU"): string {
  return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

/** Shows a deadline both in the property's state time and in the viewer's own time. */
export function deadlineInfo(deadlineIso: string, jurisdiction: Jurisdiction, viewerTz: string, locale = "en-AU") {
  return {
    propertyTime: formatInZone(deadlineIso, JURISDICTION_TIME_ZONE[jurisdiction], locale),
    viewerTime: formatInZone(deadlineIso, viewerTz, locale)
  };
}

/** The calendar date (YYYY-MM-DD) of an instant in the given time zone. */
export function localDateInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/**
 * The date a licence expiry is judged against: the instant's calendar date in the jurisdiction's own zone.
 * Fails closed: undefined when the jurisdiction has no zone or the instant is invalid, so callers must treat it as not current.
 */
export function licenceLocalDate(nowIso: string, jurisdiction: Jurisdiction): string | undefined {
  const tz = JURISDICTION_TIME_ZONE[jurisdiction];
  if (tz === undefined) return undefined;
  try { return localDateInZone(nowIso, tz); } catch { return undefined; }
}
