import type { Queryable } from "./db";
import type { MandateConditionKey, MandateVersion, QuietHours } from "../domain/mandate";

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const COLS = `listing_id, version, floor_price_sealed, target_price_cents, max_counter_rounds, max_concession_bps_per_round, approved_conditions,
  settlement_min_days, settlement_max_days, auto_mode_enabled, quiet_hours, set_by_kind, created_at`;

function toVersion(r: Record<string, unknown>): MandateVersion {
  const qh = r["quiet_hours"] as Partial<QuietHours> | null;
  return {
    listingId: String(r["listing_id"]), version: Number(r["version"]), floorSealed: String(r["floor_price_sealed"]),
    targetPriceCents: Number(r["target_price_cents"]), maxCounterRounds: Number(r["max_counter_rounds"]),
    maxConcessionBpsPerRound: Number(r["max_concession_bps_per_round"]),
    approvedConditions: (Array.isArray(r["approved_conditions"]) ? r["approved_conditions"] : []).map(String) as MandateConditionKey[],
    settlementMinDays: Number(r["settlement_min_days"]), settlementMaxDays: Number(r["settlement_max_days"]),
    autoModeEnabled: r["auto_mode_enabled"] === true,
    quietHours: { from: String(qh?.from ?? "20:00"), to: String(qh?.to ?? "08:00") },
    setBy: r["set_by_kind"] === "agent" ? "agent" : "owner", createdAt: iso(r["created_at"] as Date | string)
  };
}

/** Every version for a listing, newest first (at most 100). */
export async function mandateHistoryPg(db: Queryable, listingId: string): Promise<MandateVersion[]> {
  const r = await db.query(`SELECT ${COLS} FROM negotiation_mandate WHERE listing_id = $1 ORDER BY version DESC LIMIT 100`, [listingId]);
  return r.rows.map(toVersion);
}

/**
 * Saves the next version only if the latest version is still `expectedVersion` (0 = none yet), in one statement.
 * Two people saving at once: the second gets false and must reload. Returns the saved version or undefined.
 */
export async function insertMandatePg(
  db: Queryable, v: Omit<MandateVersion, "version" | "createdAt">, expectedVersion: number, setByUserId: string, now: string
): Promise<MandateVersion | undefined> {
  const r = await db.query(
    `WITH cur AS (SELECT COALESCE(MAX(version), 0) AS v FROM negotiation_mandate WHERE listing_id = $1)
     INSERT INTO negotiation_mandate (listing_id, version, floor_price_sealed, target_price_cents, max_counter_rounds, max_concession_bps_per_round,
       approved_conditions, settlement_min_days, settlement_max_days, auto_mode_enabled, quiet_hours, set_by, set_by_kind, created_at)
     SELECT $1, cur.v + 1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12, $13 FROM cur WHERE cur.v = $14
     ON CONFLICT (listing_id, version) DO NOTHING
     RETURNING ${COLS}`,
    [v.listingId, v.floorSealed, v.targetPriceCents, v.maxCounterRounds, v.maxConcessionBpsPerRound, JSON.stringify(v.approvedConditions),
      v.settlementMinDays, v.settlementMaxDays, v.autoModeEnabled, JSON.stringify(v.quietHours), setByUserId, v.setBy, now, expectedVersion]
  );
  return r.rows[0] ? toVersion(r.rows[0]) : undefined;
}
