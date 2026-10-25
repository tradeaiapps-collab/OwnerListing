import { NextResponse } from "next/server";
import { DEFAULT_THEME, FONTS, NAV_CATALOG } from "../../../../src/domain/site-theme";
import { getDb } from "../../../../src/server/context";
import { MAX_SETTINGS_BYTES, NO_STORE, outcomeResponse, parseSettings, readBoundedJson, versionOrNull } from "../../../../src/server/site-route";
import { loadView, saveDraft } from "../../../../src/server/site-theme-db";
import { fail, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const PERMISSION = "theme.edit";

/** Draft, published settings, version history and the option lists the editor needs. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  const view = await loadView(getDb());
  return NextResponse.json({
    ...view, defaults: DEFAULT_THEME,
    options: { fonts: FONTS.map(f => ({ id: f.id, label: f.label, stack: f.stack, webFont: f.google !== undefined })), nav: NAV_CATALOG }
  }, { headers: NO_STORE });
}

/** Saves the editor's settings as a new draft version. Body: { baseVersion: number | null, settings }. Nothing goes live until it is published. */
async function handlePut(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, MAX_SETTINGS_BYTES);
  if (body instanceof NextResponse) return body;
  const base = versionOrNull(body["baseVersion"]);
  if (base === undefined) return fail(400, "baseVersion must be the draft version you loaded, or null.");
  const parsed = parseSettings(body["settings"]);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  return outcomeResponse(await saveDraft(db, staff, base, parsed.value), () => loadView(db));
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
