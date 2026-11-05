import { NextResponse } from "next/server";
import { SUGGESTION_TYPES, TYPE_LABEL, parseOptimizationSettings } from "../../../../src/domain/listing-optimization";
import { getDb, getDeps } from "../../../../src/server/context";
import { adoptionStats, getOptimizationSettings, recentOptimizationChanges, saveOptimizationSettings } from "../../../../src/server/listing-optimization-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const noStore = { "cache-control": "no-store" };

/** The site settings, how often each suggestion type is followed, and the latest changes. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "listing_optimization.manage");
  if (staff instanceof NextResponse) return staff;
  const db = getDb();
  const [settings, stats, changes] = await Promise.all([getOptimizationSettings(db), adoptionStats(db, getDeps().now()), recentOptimizationChanges(db)]);
  return NextResponse.json({ settings, stats, changes, types: SUGGESTION_TYPES.map(t => ({ type: t, label: TYPE_LABEL[t] })) }, { headers: noStore });
}

/** Body: any of { enabled, minPhotos, minDescriptionWords, maxPriceCutPercent, disabledTypes }. Unsent fields keep their value. Every change is logged with before and after. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "listing_optimization.manage");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  if (!body) return fail(400, "Send a JSON object.");
  const db = getDb();
  const { updatedAt: _a, updatedBy: _b, updatedByName: _c, ...before } = await getOptimizationSettings(db);
  const parsed = parseOptimizationSettings(body, before);
  if (!parsed.ok) return fail(400, parsed.error);
  await saveOptimizationSettings(db, parsed.value, staff.id);
  const event = parsed.value.enabled !== before.enabled ? (parsed.value.enabled ? "enabled" : "disabled") : "updated";
  await staffAudit(staff, "listing_optimization_settings", "global", `staff.listing_optimization.${event}`, { before, after: parsed.value });
  return NextResponse.json({ settings: await getOptimizationSettings(db) }, { headers: noStore });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
