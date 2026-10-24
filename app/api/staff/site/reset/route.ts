import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { MAX_SETTINGS_BYTES, outcomeResponse, readBoundedJson, versionOrNull } from "../../../../../src/server/site-route";
import { loadView, resetToDefaults } from "../../../../../src/server/site-theme-db";
import { fail, staffGate } from "../../../../../src/server/staff-route";

/** Reset to the built-in defaults as a new draft (not live until published). Body: { baseVersion: number | null }. */
export async function POST(req: Request) {
  const staff = await staffGate(req, "theme.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, MAX_SETTINGS_BYTES);
  if (body instanceof NextResponse) return body;
  const base = versionOrNull(body["baseVersion"]);
  if (base === undefined) return fail(400, "baseVersion must be the draft version you loaded, or null.");
  const db = getDb();
  return outcomeResponse(await resetToDefaults(db, staff, base), () => loadView(db));
}
