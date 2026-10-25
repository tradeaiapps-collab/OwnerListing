import { NextResponse } from "next/server";
import { DEFAULT_GUIDE, GUIDE_DISCLAIMER, GUIDE_INTENTS, GUIDE_LIMITS, validateGuideContent } from "../../../../src/domain/guide-assistant";
import { getDb } from "../../../../src/server/context";
import { loadGuideView, saveGuideDraft } from "../../../../src/server/guide-assistant-db";
import { NO_STORE, readBoundedJson, versionOrNull } from "../../../../src/server/site-route";
import { fail, staffGate } from "../../../../src/server/staff-route";

/** Drafting the guide assistant's text is website content: site.content.edit. Making it live needs site.content.publish (publish route). */
const PERMISSION = "site.content.edit";
const MAX_BYTES = 32 * 1024;

export async function GET(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  const view = await loadGuideView(getDb());
  return NextResponse.json({ ...view, defaults: DEFAULT_GUIDE, intents: GUIDE_INTENTS, limits: GUIDE_LIMITS, disclaimer: GUIDE_DISCLAIMER }, { headers: NO_STORE });
}

/** Saves a new draft version. Body: { baseVersion: number | null, content }. Plain text only; nothing goes live until it is published. */
export async function PUT(req: Request) {
  const staff = await staffGate(req, PERMISSION);
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, MAX_BYTES);
  if (body instanceof NextResponse) return body;
  const base = versionOrNull(body["baseVersion"]);
  if (base === undefined) return fail(400, "baseVersion must be the version you loaded, or null.");
  const parsed = validateGuideContent(body["content"]);
  if (!parsed.ok) return NextResponse.json({ error: "Some fields are not valid.", fields: parsed.errors }, { status: 400, headers: NO_STORE });
  const db = getDb();
  const out = await saveGuideDraft(db, staff, base, parsed.value);
  if (!out.ok) return fail(out.code === "conflict" ? 409 : 404, out.error);
  return NextResponse.json(await loadGuideView(db), { headers: NO_STORE });
}
