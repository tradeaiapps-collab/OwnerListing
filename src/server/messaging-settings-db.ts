import { randomUUID } from "node:crypto";
import { messagingKeyUsable, openSetting, sealSetting } from "../domain/messaging-crypto";
import { FIELDS, isSecretField, pick, resolveMessaging, type MessagingField, type ResolvedMessaging } from "../domain/messaging-settings";
import type { StaffActor } from "../domain/staff-access";
import { appendAuditPg, type Queryable } from "./db";

type Env = Readonly<Record<string, string | undefined>>;
export type Changes = Partial<Record<MessagingField, string | null>>;

/**
 * Stored values, secrets decrypted. A secret that cannot be opened (no key, wrong key, tampered) is simply absent,
 * so the feature that needs it stays off. Constant SQL, no user input.
 */
export async function loadStored(db: Queryable, env: Env): Promise<Partial<Record<MessagingField, string>>> {
  const r = await db.query("SELECT field, value, value_enc FROM messaging_setting");
  const key = env["MESSAGING_SETTINGS_KEY"];
  const out: Partial<Record<MessagingField, string>> = {};
  for (const row of r.rows) {
    const field = (FIELDS as readonly string[]).includes(String(row["field"])) ? (row["field"] as MessagingField) : undefined;
    if (!field) continue;
    if (typeof row["value"] === "string" && !isSecretField(field)) out[field] = row["value"];
    else if (typeof row["value_enc"] === "string" && isSecretField(field) && messagingKeyUsable(key)) {
      const v = await openSetting(row["value_enc"], key, field).catch(() => undefined);
      if (v !== undefined) out[field] = v;
    }
  }
  return out;
}

/** Settings as they apply right now: environment variables over the database. Called at send time, so a change takes effect at once. */
export async function loadResolved(db: Queryable, env: Env): Promise<ResolvedMessaging> {
  return resolveMessaging(await loadStored(db, env), env);
}

export interface FieldState { set: boolean; source: "env" | "database" | "none"; value?: string }

/** Per field: set or not, where it comes from, and the value (the caller decides what may be shown; secrets are handled by displayValue). */
export async function loadFieldStates(db: Queryable, env: Env): Promise<Record<MessagingField, FieldState>> {
  const stored = await loadStored(db, env);
  const out = {} as Record<MessagingField, FieldState>;
  for (const f of FIELDS) {
    const p = pick(f, stored, env);
    out[f] = p ? { set: true, source: p.source, ...(isSecretField(f) ? {} : { value: p.value }) } : { set: false, source: "none" };
  }
  return out;
}

/**
 * Saves changes (null clears) and audits each one in the same transaction: who, when (audit time), which field, set or cleared.
 * Never the value. Throws MessagingKeyError before writing anything when the key is unusable, so nothing is saved.
 * Values must already be validated.
 */
export async function saveSettings(db: Queryable, staff: StaffActor, changes: Changes, env: Env): Promise<void> {
  if (!db.transaction) throw new Error("Transactions are required.");
  const key = env["MESSAGING_SETTINGS_KEY"];
  const rows: { field: MessagingField; value: string | null; enc: string | null }[] = [];
  for (const f of FIELDS) {
    if (!(f in changes)) continue;
    const v = changes[f];
    if (v === undefined || v === null) rows.push({ field: f, value: null, enc: null });
    else if (isSecretField(f)) rows.push({ field: f, value: null, enc: await sealSetting(v, key, f) });
    else rows.push({ field: f, value: v, enc: null });
  }
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    for (const r of rows) {
      await tx.query(
        `INSERT INTO messaging_setting (field, value, value_enc, updated_by, updated_at) VALUES ($1, $2, $3, $4::uuid, $5::timestamptz)
         ON CONFLICT (field) DO UPDATE SET value = EXCLUDED.value, value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [r.field, r.value, r.enc, staff.id, now]);
      await appendAuditPg(tx, {
        id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "messaging_settings", aggregateId: r.field,
        eventType: "messaging.setting_changed", correlationId: randomUUID(),
        payload: { role: staff.role, field: r.field, action: r.value === null && r.enc === null ? "cleared" : "set" }
      });
    }
  });
}
