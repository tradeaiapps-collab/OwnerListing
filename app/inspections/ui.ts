export const JSON_HEADERS = { "content-type": "application/json" } as const;

export const TYPE_LABELS: Record<string, string> = {
  building: "Building inspection", pest: "Pest inspection", pre_purchase: "Pre-purchase inspection", pre_sale: "Pre-sale inspection", other: "Inspection"
};
export const STATUS_LABELS: Record<string, string> = {
  invited: "Waiting for the inspector", accepted: "Booked", declined: "Declined", completed: "Report complete", cancelled: "Cancelled"
};
export const SEVERITY_LABELS: Record<string, string> = { info: "Note", minor: "Minor", moderate: "Moderate", major: "Major", critical: "Critical" };
export const FOLLOWUP_LABELS: Record<string, string> = { none: "No follow-up", open: "Open", in_progress: "In progress", resolved: "Resolved", wont_fix: "Won't fix" };
export const ROLE_LABELS: Record<string, string> = { manager: "You booked this", inspector: "You are the inspector", viewer: "Shared with you" };

export const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** datetime-local value (no zone) to an ISO instant in the browser's time zone. */
export const localToIso = (v: string) => new Date(v).toISOString();
export const defaultLocal = () => {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
