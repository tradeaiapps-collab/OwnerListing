import { createHash, randomUUID } from "node:crypto";
import type { MetaConfig } from "../adapters/ad-lead-providers";
import { openSetting, sealSetting, messagingKeyUsable } from "../domain/messaging-crypto";
import {
  META_FIELDS, isMetaSecret, metaSettingsKey, pickMeta, resolveMeta, type MetaField, type MetaTestResult
} from "../domain/meta-lead-settings";
import type { StaffActor } from "../domain/staff-access";
import { appendAuditPg, type Queryable } from "./db";

type Env = Readonly<Record<string, string | undefined>>;
export type MetaChanges = Partial<Record<MetaField, string | null>>;
const aadField = (f: MetaField) => `meta-lead.${f}`;

/** Stored values, secrets opened. A secret that cannot be opened (no key, wrong key, tampered) is absent, so the webhook stays off. Constant SQL. */
export async function loadMetaStored(db: Queryable, env: Env): Promise<Partial<Record<MetaField, string>>> {
  return (await loadMetaStoredDetail(db, env)).values;
}

/** Same, plus the secret fields that are saved but cannot be opened with the current key (so the screen can say so instead of just "Disconnected"). */
export async function loadMetaStoredDetail(db: Queryable, env: Env): Promise<{ values: Partial<Record<MetaField, string>>; unreadable: MetaField[] }> {
  const r = await db.query("SELECT field, value, value_enc FROM meta_lead_setting");
  const key = metaSettingsKey(env);
  const out: Partial<Record<MetaField, string>> = {};
  const unreadable: MetaField[] = [];
  for (const row of r.rows) {
    const field = (META_FIELDS as readonly string[]).includes(String(row["field"])) ? (row["field"] as MetaField) : undefined;
    if (!field) continue;
    if (typeof row["value"] === "string" && !isMetaSecret(field)) out[field] = row["value"];
    else if (typeof row["value_enc"] === "string" && isMetaSecret(field)) {
      const v = messagingKeyUsable(key) ? await openSetting(row["value_enc"], key, aadField(field)).catch(() => undefined) : undefined;
      if (v !== undefined) out[field] = v;
      else unreadable.push(field);
    }
  }
  return { values: out, unreadable };
}

/** Fingerprint of the connection as it applies now. A test result is only kept when this is the same before and after the call to Meta. */
export async function metaConfigFingerprint(db: Queryable, env: Env): Promise<string> {
  const cfg = await loadMetaConfig(db, env);
  return createHash("sha256").update(JSON.stringify(cfg ?? null)).digest("hex");
}

/** The connection as it applies right now (environment over database), or null while incomplete. Called per webhook request, so a change applies at once. */
export async function loadMetaConfig(db: Queryable, env: Env): Promise<(MetaConfig & { appId?: string }) | null> {
  return resolveMeta(await loadMetaStored(db, env), env);
}

export interface MetaFieldState { set: boolean; source: "env" | "database" | "none"; value?: string }
export async function loadMetaFieldStates(db: Queryable, env: Env): Promise<Record<MetaField, MetaFieldState>> {
  const stored = await loadMetaStored(db, env);
  const out = {} as Record<MetaField, MetaFieldState>;
  for (const f of META_FIELDS) {
    const p = pickMeta(f, stored, env);
    out[f] = p ? { set: true, source: p.source, ...(isMetaSecret(f) ? {} : { value: p.value }) } : { set: false, source: "none" };
  }
  return out;
}

export async function loadMetaTest(db: Queryable): Promise<MetaTestResult | null> {
  const r = await db.query("SELECT tested_at, ok, message, page_name, page_id, app_checked FROM meta_lead_test WHERE id = 1");
  const x = r.rows[0];
  return x ? { at: new Date(String(x["tested_at"])).toISOString(), ok: x["ok"] === true, message: String(x["message"]), pageName: x["page_name"] ? String(x["page_name"]) : null, pageId: x["page_id"] ? String(x["page_id"]) : null, appChecked: x["app_checked"] === true } : null;
}

const audit = (tx: Queryable, staff: StaffActor, now: string, eventType: string, aggregateId: string, payload: Record<string, unknown>) =>
  appendAuditPg(tx, { id: randomUUID(), occurredAt: now, actorType: "user", actorId: staff.id, aggregateType: "meta_lead_settings", aggregateId, eventType, correlationId: randomUUID(), payload: { role: staff.role, ...payload } });

/**
 * Saves changes (null clears) and audits each one (field name and set/cleared only, never the value) in one transaction, and forgets the last
 * test result because it described the old keys. Throws MessagingKeyError before writing anything when the key is unusable and a secret is being set.
 * Values must already be validated.
 */
export async function saveMetaSettings(db: Queryable, staff: StaffActor, changes: MetaChanges, env: Env): Promise<void> {
  if (!db.transaction) throw new Error("Transactions are required.");
  const key = metaSettingsKey(env);
  const rows: { field: MetaField; value: string | null; enc: string | null }[] = [];
  for (const f of META_FIELDS) {
    if (!(f in changes)) continue;
    const v = changes[f];
    if (v === undefined || v === null) rows.push({ field: f, value: null, enc: null });
    else if (isMetaSecret(f)) rows.push({ field: f, value: null, enc: await sealSetting(v, key, aadField(f)) });
    else rows.push({ field: f, value: v, enc: null });
  }
  if (rows.length === 0) return;
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    for (const r of rows) {
      if (r.value === null && r.enc === null) await tx.query("DELETE FROM meta_lead_setting WHERE field = $1", [r.field]);
      else await tx.query(
        `INSERT INTO meta_lead_setting (field, value, value_enc, updated_by, updated_at) VALUES ($1, $2, $3, $4::uuid, $5::timestamptz)
         ON CONFLICT (field) DO UPDATE SET value = EXCLUDED.value, value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [r.field, r.value, r.enc, staff.id, now]);
      await audit(tx, staff, now, "meta_lead.setting_changed", r.field, { field: r.field, action: r.value === null && r.enc === null ? "cleared" : "set" });
    }
    await tx.query("DELETE FROM meta_lead_test WHERE id = 1");
  });
}

/** Disconnect: removes every stored setting and the test result. Settings supplied by environment variables are not touched (the screen says so). */
export async function disconnectMeta(db: Queryable, staff: StaffActor): Promise<void> {
  if (!db.transaction) throw new Error("Transactions are required.");
  const now = new Date().toISOString();
  await db.transaction(async tx => {
    await tx.query("DELETE FROM meta_lead_setting");
    await tx.query("DELETE FROM meta_lead_test");
    await audit(tx, staff, now, "meta_lead.disconnected", "connection", {});
  });
}

export async function recordMetaTest(db: Queryable, staff: StaffActor, r: { ok: boolean; message: string; pageId: string | null; pageName: string | null; appChecked: boolean }): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO meta_lead_test (id, tested_at, tested_by, ok, message, page_name, page_id, app_checked) VALUES (1, $1::timestamptz, $2::uuid, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET tested_at = EXCLUDED.tested_at, tested_by = EXCLUDED.tested_by, ok = EXCLUDED.ok, message = EXCLUDED.message,
       page_name = EXCLUDED.page_name, page_id = EXCLUDED.page_id, app_checked = EXCLUDED.app_checked`,
    [now, staff.id, r.ok, r.message.slice(0, 300), r.pageName, r.pageId, r.appChecked]);
  await audit(db, staff, now, "meta_lead.tested", "connection", { ok: r.ok });
}
