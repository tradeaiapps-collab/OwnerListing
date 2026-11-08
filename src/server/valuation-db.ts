import { DEFAULT_VALUATION_SETTINGS, type ValuationSettings } from "../domain/valuation";
import type { Queryable } from "./db";

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export interface StoredSettings extends ValuationSettings { updatedAt: string | null; updatedBy: string | null; updatedByName: string | null }
export interface OverrideRow { listingId: string; enabled: boolean; reason: string; setBy: string | null; setAt: string }

/** The one settings row. FAILS CLOSED: a read error or a missing row means valuations are off. */
export async function getValuationSettings(db: Queryable): Promise<StoredSettings> {
  try {
    const x = (await db.query("SELECT s.*, u.display_name AS updated_by_name FROM valuation_settings s LEFT JOIN app_user u ON u.id = s.updated_by WHERE s.id = 1")).rows[0];
    if (!x) return { ...DEFAULT_VALUATION_SETTINGS, updatedAt: null, updatedBy: null, updatedByName: null };
    return {
      enabled: x["enabled"] === true, minComps: Number(x["min_comps_required"]), highConfidenceComps: Number(x["high_confidence_comps"]), showRange: x["show_fair_range"] !== false,
      updatedAt: iso(x["updated_at"]), updatedBy: x["updated_by"] ? String(x["updated_by"]) : null, updatedByName: x["updated_by_name"] ? String(x["updated_by_name"]) : null
    };
  } catch { return { ...DEFAULT_VALUATION_SETTINGS, updatedAt: null, updatedBy: null, updatedByName: null }; }
}

export async function saveValuationSettings(db: Queryable, s: ValuationSettings, staffId: string): Promise<void> {
  await db.query(
    `INSERT INTO valuation_settings (id, enabled, min_comps_required, high_confidence_comps, show_fair_range, updated_by, updated_at) VALUES (1,$1,$2,$3,$4,$5::uuid,now())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, min_comps_required = EXCLUDED.min_comps_required, high_confidence_comps = EXCLUDED.high_confidence_comps,
       show_fair_range = EXCLUDED.show_fair_range, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [s.enabled, s.minComps, s.highConfidenceComps, s.showRange, staffId]);
}

const overrideRow = (x: Record<string, unknown>): OverrideRow => ({
  listingId: String(x["listing_id"]), enabled: x["enabled"] === true, reason: String(x["override_reason"]), setBy: x["set_by"] ? String(x["set_by"]) : null, setAt: iso(x["set_at"])
});

/** A read error counts as "no override" so a database blip does not hide the card; the site switch is read the same way and fails closed. */
export async function getOverride(db: Queryable, listingId: string): Promise<OverrideRow | undefined> {
  const x = (await db.query("SELECT * FROM valuation_overrides WHERE listing_id = $1::uuid", [listingId])).rows[0];
  return x ? overrideRow(x) : undefined;
}

export async function listOverrides(db: Queryable, limit = 200): Promise<(OverrideRow & { title: string | null })[]> {
  const r = await db.query(
    `SELECT o.*, l.title FROM valuation_overrides o LEFT JOIN property_listing l ON l.id = o.listing_id ORDER BY o.set_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 500)]);
  return r.rows.map(x => ({ ...overrideRow(x), title: x["title"] ? String(x["title"]) : null }));
}

export async function setOverride(db: Queryable, listingId: string, enabled: boolean, reason: string, staffId: string): Promise<void> {
  await db.query(
    `INSERT INTO valuation_overrides (listing_id, enabled, override_reason, set_by, set_at) VALUES ($1::uuid,$2,$3,$4::uuid,now())
     ON CONFLICT (listing_id) DO UPDATE SET enabled = EXCLUDED.enabled, override_reason = EXCLUDED.override_reason, set_by = EXCLUDED.set_by, set_at = now()`,
    [listingId, enabled, reason, staffId]);
}

export async function clearOverride(db: Queryable, listingId: string): Promise<boolean> {
  return ((await db.query("DELETE FROM valuation_overrides WHERE listing_id = $1::uuid RETURNING listing_id", [listingId])).rows.length) > 0;
}

/** Latest changes to the settings and overrides from the audit log, newest first. */
export async function recentValuationChanges(db: Queryable, limit = 20): Promise<{ at: string; actorName: string | null; event: string; payload: Record<string, unknown> }[]> {
  const r = await db.query(
    `SELECT a.occurred_at, u.display_name, a.event_type, a.payload FROM audit_event a LEFT JOIN app_user u ON u.id::text = a.actor_id
      WHERE a.event_type LIKE 'staff.valuation.%' ORDER BY a.occurred_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)]);
  return r.rows.map(x => ({ at: iso(x["occurred_at"]), actorName: x["display_name"] ? String(x["display_name"]) : null, event: String(x["event_type"]), payload: (x["payload"] ?? {}) as Record<string, unknown> }));
}
