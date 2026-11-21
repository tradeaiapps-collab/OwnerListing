import { NextResponse } from "next/server";
import { getDb } from "../../../../src/server/context";
import { getRetentionSettings, previewRetention, recentRetentionRuns, runRetentionPurge, saveRetentionSettings, validRetentionDays } from "../../../../src/server/elena-retention-db";
import { fail, readJsonObject, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const noStore = { "cache-control": "no-store" };

/** Retention settings, what a purge would scrub now, and the last runs (counts only). Needs config.edit. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  const db = getDb(), settings = await getRetentionSettings(db);
  return NextResponse.json({ settings, pending: await previewRetention(db, new Date().toISOString(), settings.retentionDays), runs: await recentRetentionRuns(db) }, { headers: noStore });
}

/** Body { action: "save", enabled, retentionDays } or { action: "purge" }. Purging uses the saved period, works while retention is off, and is audited. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "config.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readJsonObject(req);
  const db = getDb();
  if (body?.["action"] === "save") {
    if (typeof body["enabled"] !== "boolean" || !validRetentionDays(body["retentionDays"])) return fail(400, "Choose on or off and a period of 90 to 3650 days.");
    await saveRetentionSettings(db, staff.id, { enabled: body["enabled"], retentionDays: body["retentionDays"] });
    return NextResponse.json({ ok: true }, { headers: noStore });
  }
  if (body?.["action"] === "purge") {
    const s = await getRetentionSettings(db);
    const counts = await runRetentionPurge(db, new Date().toISOString(), s.retentionDays, { trigger: "staff", staffId: staff.id });
    return NextResponse.json({ ok: true, ...counts }, { headers: noStore });
  }
  return fail(400, "Unknown action.");
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
