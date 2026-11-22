import { NextResponse } from "next/server";
import { parseValuationSettings } from "../../../../src/domain/valuation";
import { getDb } from "../../../../src/server/context";
import { getValuationSettings, listOverrides, recentValuationChanges, saveValuationSettings } from "../../../../src/server/valuation-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const noStore = { "cache-control": "no-store" };

/** The site-wide valuation settings, the listings with an override and the latest changes. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "valuation.manage");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const [settings, overrides, changes] = await Promise.all([getValuationSettings(db), listOverrides(db), recentValuationChanges(db)]);
  return NextResponse.json({ settings, overrides, changes }, { headers: noStore });
}

/** Body: any of { enabled, minComps, highConfidenceComps, showRange }. Unsent fields keep their value. Every change is logged with before and after. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "valuation.manage");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const db = getDb();
  const before = await getValuationSettings(db);
  const parsed = parseValuationSettings(body, before);
  if (!parsed.ok) return fail(400, parsed.error);
  const { enabled, minComps, highConfidenceComps, showRange } = before;
  await saveValuationSettings(db, parsed.value, staff.id);
  const event = parsed.value.enabled !== enabled ? (parsed.value.enabled ? "enabled" : "disabled") : "updated";
  await staffAudit(staff, "valuation_settings", "global", `staff.valuation.${event}`, { before: { enabled, minComps, highConfidenceComps, showRange }, after: parsed.value });
  return NextResponse.json({ settings: await getValuationSettings(db) }, { headers: noStore });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
