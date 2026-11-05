import { NextResponse } from "next/server";
import { messagingKeyUsable } from "../../../../src/domain/messaging-crypto";
import {
  META_FIELDS, META_WEBHOOK_PATH, isMetaField, metaSettingsKey, metaStatus, resolveMeta, validateMetaField, type MetaField
} from "../../../../src/domain/meta-lead-settings";
import { getDb } from "../../../../src/server/context";
import { disconnectMeta, loadMetaFieldStates, loadMetaStoredDetail, loadMetaTest, saveMetaSettings, type MetaChanges } from "../../../../src/server/meta-lead-settings-db";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Facebook / Instagram lead ads connection (ad_leads.manage, a sensitive permission: super admin by default). Gate first, then the work. */
const PERMISSION = "ad_leads.manage";

async function view() {
  const env = process.env, db = getDb();
  const [states, detail, test] = await Promise.all([loadMetaFieldStates(db, env), loadMetaStoredDetail(db, env), loadMetaTest(db)]);
  const configured = resolveMeta(detail.values, env) !== null;
  const fields = {} as Record<MetaField, { set: boolean; source: string; value?: string }>;
  for (const f of META_FIELDS) fields[f] = { set: states[f].set, source: states[f].source, ...(states[f].value !== undefined ? { value: states[f].value } : {}) };
  return { keyConfigured: messagingKeyUsable(metaSettingsKey(env)), unreadable: detail.unreadable, fields, configured, status: metaStatus(configured, test), test, webhookPath: META_WEBHOOK_PATH };
}

/** Current connection, status and last test. Secrets are never returned, only "set" or "not set". */
async function handleGet(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}

/**
 * Saves settings. Body: { "<field>": "<value>" } for the fields to change; an empty string clears a field; omitted fields stay as they are.
 * Refused (nothing saved) while the encryption key is unusable. Each change is audited with the field name only.
 */
async function handlePut(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  if (!messagingKeyUsable(metaSettingsKey(process.env))) {
    return NextResponse.json({ error: "Encryption key not configured. Nothing was saved.", code: "key_not_configured" }, { status: 503 });
  }
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object of settings.");
  const changes: MetaChanges = {};
  const errors: Record<string, string> = {};
  for (const [name, raw] of Object.entries(body)) {
    if (!isMetaField(name)) { errors[name.slice(0, 40)] = "Unknown setting."; continue; }
    if (raw === "" || raw === null) { changes[name] = null; continue; }
    const v = validateMetaField(name, raw);
    if (v.ok) changes[name] = v.value;
    else errors[name] = v.error;
  }
  if (Object.keys(errors).length > 0) return NextResponse.json({ error: "Some settings are not valid.", fields: errors }, { status: 400 });
  if (Object.keys(changes).length === 0) return fail(400, "No settings to change.");
  await saveMetaSettings(getDb(), staff, changes, process.env);
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}

/** Disconnect: forgets every saved key. Re-connect by entering them again. Keys set as server environment variables stay (the screen says so). */
async function handleDelete(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  await disconnectMeta(getDb(), staff);
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
export const DELETE = withApi(handleDelete);
