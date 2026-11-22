import { NextResponse } from "next/server";
import { LOCALES } from "../../../../src/domain/i18n";
import { canEnableLocale } from "../../../../src/i18n";
import { getDb } from "../../../../src/server/context";
import { listLocaleStatusPg, setLocaleEnabledPg } from "../../../../src/server/terms-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const noStore = { "cache-control": "no-store" };

/** Every planned language with whether its translation is approved (can be switched on) and whether it is on. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  const rows = await listLocaleStatusPg(getDb());
  const languages = LOCALES.filter(l => l.code !== "en-AU").map(l => {
    const row = rows.find(r => r.code === l.code);
    return { code: l.code, name: l.name, approved: canEnableLocale(l.code), enabled: row?.enabled === true, changedAt: row?.reviewedAt ?? null };
  });
  return NextResponse.json({ languages }, { headers: noStore });
}

/** Body: { code, enabled }. Only an approved translation can be switched on; switching off is always allowed. Every change is logged. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const code = body?.["code"];
  const enabled = body?.["enabled"];
  if (typeof code !== "string" || typeof enabled !== "boolean" || !LOCALES.some(l => l.code === code && code !== "en-AU")) return fail(400, "Send { code, enabled } for a listed language.");
  if (enabled && !canEnableLocale(code)) return fail(409, "This translation has not been approved yet, so it cannot be switched on.");
  await setLocaleEnabledPg(getDb(), code, enabled, staff.id);
  await staffAudit(staff, "language", code, enabled ? "staff.language.enabled" : "staff.language.disabled", { code, enabled });
  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
