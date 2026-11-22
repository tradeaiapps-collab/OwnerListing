/** Labels and formatting shared by the rentals screens (owner desk, apply form, my rentals). */
export const JSON_HEADERS = { "content-type": "application/json" } as const;

export const CATEGORIES: [string, string][] = [
  ["plumbing", "Plumbing"], ["electrical", "Electrical"], ["gas", "Gas"], ["appliance", "Appliance"], ["heating_cooling", "Heating or cooling"], ["locks_security", "Locks and security"],
  ["windows_doors", "Windows and doors"], ["roof_leaks", "Roof and leaks"], ["pests", "Pests"], ["structure", "Walls, ceilings and structure"], ["other", "Something else"]
];
export const categoryLabel = (k: string) => CATEGORIES.find(c => c[0] === k)?.[1] ?? k;

export const URGENCY: Record<string, string> = { emergency: "Emergency", urgent: "Urgent", routine: "Routine" };
export const REPAIR_STATUS: Record<string, string> = {
  awaiting_owner: "Waiting for the owner", offered: "Contractor asked", scheduled: "Visit booked", emergency: "Emergency sent to contractors", owner_arranging: "Owner is arranging it",
  check_in: "Checking it is fixed", needs_owner: "Elena has stopped: needs the owner", closed: "Closed"
};
export const APP_STATUS: Record<string, string> = {
  submitted: "Received", info_requested: "A little more needed", shortlisted: "Shortlisted", approved: "Approved", declined: "Not successful", withdrawn: "Withdrawn"
};
export const CRITERION_STATUS: Record<string, string> = { met: "Met", not_met: "Not met", missing: "Not provided", not_asked: "Not asked" };

const dtf = new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const when = (iso: string) => dtf.format(new Date(iso));
export const money = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
export async function readError(r: Response, fallback: string): Promise<string> {
  const d = await r.json().catch(() => ({}));
  return typeof d?.error === "string" ? d.error : r.status === 401 ? "Sign in to continue." : fallback;
}
/** A datetime-local value to an ISO instant in the browser's time zone. */
export const localToIso = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : d.toISOString(); };
