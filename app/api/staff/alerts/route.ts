import { NextResponse } from "next/server";
import { ALERT_DEFS, defaultAlertSettings, parseAlertSettings } from "../../../../src/domain/alert-config";
import { staffCan } from "../../../../src/domain/staff-access";
import { loadAlertSettings, saveAlertSettings } from "../../../../src/server/alert-config-db";
import { getDb } from "../../../../src/server/context";
import { fail, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const view = (settings: unknown, canEdit: boolean) => ({
  settings, canEdit, defaults: defaultAlertSettings(),
  defs: ALERT_DEFS
});

/** Thresholds behind Elena's admin alerts. Anyone who can see the insights can read them; changing them needs config.edit. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "report.sales");
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json(view(await loadAlertSettings(getDb()), staffCan(staff, "config.edit")), { headers: { "cache-control": "no-store" } });
}

/** Saves all thresholds and on/off switches at once (validated against each range) and records who changed them. */
async function handlePut(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  const parsed = parseAlertSettings(await req.json().catch(() => null));
  if (!parsed.ok) return fail(400, parsed.error);
  const db = getDb();
  await saveAlertSettings(db, staff.id, parsed.value);
  await staffAudit(staff, "alert_config", "global", "staff.alert_config.updated", { settings: parsed.value });
  return NextResponse.json(view(await loadAlertSettings(db), true));
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
