import { ALERT_TYPES, resolveAlertSettings, type AlertSettings } from "../domain/alert-config";
import type { Queryable } from "./db";

/** Current alert settings: stored rows over the defaults. Never throws on a bad row; an unreadable table falls back to defaults. */
export async function loadAlertSettings(db: Queryable): Promise<AlertSettings> {
  const rows = (await db.query(`SELECT alert_type, threshold::float8 AS threshold, enabled FROM alert_config`)).rows;
  return resolveAlertSettings(rows.map(r => ({ alertType: String(r["alert_type"]), threshold: Number(r["threshold"]), enabled: r["enabled"] === true })));
}

/** Upserts every alert type (constant SQL; values are bound parameters). */
export async function saveAlertSettings(db: Queryable, staffId: string, s: AlertSettings): Promise<void> {
  for (const t of ALERT_TYPES) {
    await db.query(
      `INSERT INTO alert_config (alert_type, threshold, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (alert_type) DO UPDATE SET threshold = EXCLUDED.threshold, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [t, s[t].threshold, s[t].enabled, staffId]
    );
  }
}
