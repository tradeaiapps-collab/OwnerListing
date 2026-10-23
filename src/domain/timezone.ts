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
