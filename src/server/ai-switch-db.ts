import type { StaffActor } from "../domain/staff-access";
import type { Queryable } from "./db";

export interface AiSwitchEntry { enabled: boolean; reason: string; changedBy: string; changedAt: string }

/** True only when the latest switch row says on. No rows, or any database error, is OFF (fail closed). Constant SQL. */
export async function aiSwitchOn(db: Queryable): Promise<boolean> {
  try {
    const r = await db.query("SELECT enabled FROM ai_switch_event ORDER BY id DESC LIMIT 1");
    return r.rows[0]?.["enabled"] === true;
  } catch {
    return false;
  }
}

/** Newest first, at most 20. */
export async function aiSwitchHistory(db: Queryable): Promise<AiSwitchEntry[]> {
  const r = await db.query("SELECT enabled, reason, changed_by, changed_at FROM ai_switch_event ORDER BY id DESC LIMIT 20");
  return r.rows.map(x => ({
    enabled: x["enabled"] === true, reason: String(x["reason"]), changedBy: String(x["changed_by"]),
    changedAt: new Date(x["changed_at"] as string).toISOString()
  }));
}

/** Adds a history row (never updates one). */
export async function setAiSwitch(db: Queryable, staff: StaffActor, enabled: boolean, reason: string): Promise<void> {
  await db.query("INSERT INTO ai_switch_event (enabled, reason, changed_by) VALUES ($1, $2, $3)", [enabled, reason.trim(), staff.id]);
}
