/**
 * Staff-editable thresholds for Elena's admin alerts. One global setting per alert type (not per property, not per person). Every type has a
 * default and an allowed range; a missing, disabled-by-default or out-of-range stored value falls back to the default, so a bad row can never
 * switch alerts off or flood the screen. Pure functions; the SQL is in src/server/alert-config-db.ts.
 */

export const ALERT_TYPES = ["agent_unanswered", "agent_acceptance_gap", "agent_slow_reply", "area_conversion", "area_enquiry_drop", "area_quiet"] as const;
export type AlertType = typeof ALERT_TYPES[number];

export interface AlertDef {
  type: AlertType; label: string; description: string;
  /** Wording for the number: "hours", "points", "x median", "% of platform rate", "% fall", "live listings". */
  unit: string; defaultThreshold: number; min: number; max: number; step: number; /** Plain sentence with {n} where the number goes. */ example: string;
}

export const ALERT_DEFS: readonly AlertDef[] = [
  { type: "agent_unanswered", label: "Unanswered enquiries", unit: "hours", defaultThreshold: 24, min: 12, max: 72, step: 1,
    description: "An enquiry with no agent reply counts as unanswered after this many hours. An agent with 3 or more is flagged.",
    example: "Flag an agent with 3 or more enquiries unanswered for over {n} hours." },
  { type: "agent_acceptance_gap", label: "Low acceptance", unit: "points under platform", defaultThreshold: 20, min: 5, max: 50, step: 1,
    description: "An agent whose accepted-offer rate is this many percentage points under the platform rate (needs 5 decided offers).",
    example: "Flag an agent whose acceptance rate is {n} or more points under the platform rate." },
  { type: "agent_slow_reply", label: "Slow replies", unit: "x the usual median", defaultThreshold: 2, min: 1.5, max: 5, step: 0.5,
    description: "An agent whose median first-reply time is this many times the median of agents (needs 5 enquiries).",
    example: "Flag an agent whose median reply time is {n} times the usual or more." },
  { type: "area_conversion", label: "Weak conversion", unit: "% of platform rate", defaultThreshold: 50, min: 10, max: 90, step: 5,
    description: "An area where offers per enquiry are at or below this share of the platform-wide rate (needs 5 enquiries).",
    example: "Flag an area converting enquiries to offers at {n}% of the platform rate or less." },
  { type: "area_enquiry_drop", label: "Falling enquiries", unit: "% fall", defaultThreshold: 40, min: 10, max: 90, step: 5,
    description: "An area whose enquiries fell by at least this much against the previous period (needs 5 enquiries before).",
    example: "Flag an area where enquiries fell {n}% or more." },
  { type: "area_quiet", label: "Stale listings", unit: "live listings, no enquiries", defaultThreshold: 3, min: 1, max: 20, step: 1,
    description: "An area with this many live listings and no enquiries at all in the period.",
    example: "Flag an area with {n} or more live listings and no enquiries." }
];

export const exampleText = (d: AlertDef, n: number) => d.example.replace("{n}", String(n));

export interface AlertSetting { threshold: number; enabled: boolean }
export type AlertSettings = Record<AlertType, AlertSetting>;

const DEF_BY_TYPE = new Map(ALERT_DEFS.map(d => [d.type, d]));
export const isAlertType = (v: unknown): v is AlertType => typeof v === "string" && (ALERT_TYPES as readonly string[]).includes(v);
export const thresholdOk = (type: AlertType, n: unknown): n is number => {
  const d = DEF_BY_TYPE.get(type)!;
  return typeof n === "number" && Number.isFinite(n) && n >= d.min && n <= d.max && Math.abs(Math.round(n / d.step) * d.step - n) < 1e-9;
};

export const defaultAlertSettings = (): AlertSettings =>
  Object.fromEntries(ALERT_DEFS.map(d => [d.type, { threshold: d.defaultThreshold, enabled: true }])) as AlertSettings;

/** Stored rows laid over the defaults. Unknown types and invalid thresholds are ignored (the default stays); `enabled` is kept either way. */
export function resolveAlertSettings(rows: readonly { alertType: string; threshold: number; enabled: boolean }[]): AlertSettings {
  const out = defaultAlertSettings();
  for (const r of rows) {
    if (!isAlertType(r.alertType)) continue;
    out[r.alertType] = { threshold: thresholdOk(r.alertType, r.threshold) ? r.threshold : out[r.alertType].threshold, enabled: r.enabled === true };
  }
  return out;
}

/** Checks a save request: every type present, each threshold in range, each enabled a boolean. */
export function parseAlertSettings(body: unknown): { ok: true; value: AlertSettings } | { ok: false; error: string } {
  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>)["settings"] : undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send the settings for every alert." };
  const value = defaultAlertSettings();
  for (const d of ALERT_DEFS) {
    const s = (raw as Record<string, unknown>)[d.type];
    if (s === null || typeof s !== "object") return { ok: false, error: `Missing setting for ${d.label}.` };
    const { threshold, enabled } = s as Record<string, unknown>;
    if (!thresholdOk(d.type, threshold)) return { ok: false, error: `${d.label}: enter a number from ${d.min} to ${d.max} (${d.unit}).` };
    if (typeof enabled !== "boolean") return { ok: false, error: `${d.label}: enabled must be on or off.` };
    value[d.type] = { threshold, enabled };
  }
  return { ok: true, value };
}
