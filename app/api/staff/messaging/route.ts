import { NextResponse } from "next/server";
import { messagingKeyUsable } from "../../../../src/domain/messaging-crypto";
import { FIELDS, displayValue, isField, resolveMessaging, validateField, type MessagingField } from "../../../../src/domain/messaging-settings";
import { getDb } from "../../../../src/server/context";
import { loadFieldStates, loadStored, saveSettings, type Changes } from "../../../../src/server/messaging-settings-db";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";

/** Email and SMS settings (messaging.settings, a sensitive permission: super admin by default). Gate first, then the work. */
const PERMISSION = "messaging.settings";

async function view() {
  const env = process.env;
  const states = await loadFieldStates(getDb(), env);
  const fields = {} as Record<MessagingField, { set: boolean; source: string; display?: string }>;
  for (const f of FIELDS) {
    const s = states[f];
    const shown = s.value !== undefined ? displayValue(f, s.value) : undefined;
    fields[f] = { set: s.set, source: s.source, ...(shown !== undefined ? { display: shown } : {}) };
  }
  const resolved = resolveMessaging(await loadStored(getDb(), env), env);
  return { keyConfigured: messagingKeyUsable(env["MESSAGING_SETTINGS_KEY"]), fields, smsConfigured: resolved.sms !== null, emailConfigured: resolved.email !== null };
}

/** Current settings, masked. Secrets are never returned, only "set" or "not set". */
export async function GET(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}

/**
 * Updates settings. Body: { "<field>": "<value>" } for the fields to change; an empty string clears a field; omitted fields stay as they are.
 * Refused (nothing saved) while MESSAGING_SETTINGS_KEY is unusable. Each change is audited with the field name only.
 */
export async function PUT(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  if (!messagingKeyUsable(process.env["MESSAGING_SETTINGS_KEY"])) {
    return NextResponse.json({ error: "Encryption key not configured. Nothing was saved.", code: "key_not_configured" }, { status: 503 });
  }
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object of settings.");
  const changes: Changes = {};
  const errors: Record<string, string> = {};
  for (const [name, raw] of Object.entries(body)) {
    if (!isField(name)) { errors[name.slice(0, 40)] = "Unknown setting."; continue; }
    if (raw === "" || raw === null) { changes[name] = null; continue; }
    const v = validateField(name, raw);
    if (v.ok) changes[name] = v.value;
    else errors[name] = v.error;
  }
  if (Object.keys(errors).length > 0) return NextResponse.json({ error: "Some settings are not valid.", fields: errors }, { status: 400 });
  if (Object.keys(changes).length === 0) return fail(400, "No settings to change.");
  await saveSettings(getDb(), staff, changes, process.env);
  return NextResponse.json(await view(), { headers: { "cache-control": "no-store" } });
}
