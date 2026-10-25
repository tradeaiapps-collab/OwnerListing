import { NextResponse } from "next/server";
import { getDb } from "../../../../../src/server/context";
import { MAX_SETTINGS_BYTES, outcomeResponse, readBoundedJson, versionOrNull } from "../../../../../src/server/site-route";
import { clearThemeCache } from "../../../../../src/server/site-theme";
import { loadView, revertTo } from "../../../../../src/server/site-theme-db";
import { fail, staffGate } from "../../../../../src/server/staff-route";
import { withApi } from "../../../../../src/server/api/with-api";

/** One-click rollback. Body: { version }. Copies that version into a NEW version and makes it live at once; history is never rewritten. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "theme.edit");
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, MAX_SETTINGS_BYTES);
  if (body instanceof NextResponse) return body;
  const version = versionOrNull(body["version"]);
  if (version === undefined || version === null) return fail(400, "version is required.");
  const db = getDb();
  const outcome = await revertTo(db, staff, version);
  clearThemeCache(); // this server shows the change at once; other servers pick it up within the cache time (about 45 s)
  return outcomeResponse(outcome, () => loadView(db));
}

export const POST = withApi(handlePost);
