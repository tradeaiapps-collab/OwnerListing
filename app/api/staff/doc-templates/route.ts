import { NextResponse } from "next/server";
import { validateTemplateContent, LIMITS } from "../../../../src/domain/doc-templates";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb } from "../../../../src/server/context";
import { createTemplate, installStarters, loadTemplates, publishVersion, saveVersion } from "../../../../src/server/doc-template-db";
import { NO_STORE, readBoundedJson } from "../../../../src/server/site-route";
import { fail, staffGateAny } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

const MAX_BYTES = 160 * 1024;
const STATUS = { conflict: 409, not_found: 404, forbidden: 403, invalid: 400 } as const;

async function handleGet(req: Request) {
  const staff = await staffGateAny(req, ["doc_template.edit", "doc_template.publish"]);
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({ templates: await loadTemplates(getDb()), limits: LIMITS, canEdit: staffCan(staff, "doc_template.edit"), canPublish: staffCan(staff, "doc_template.publish") }, { headers: NO_STORE });
}

/**
 * Body: { action: "install_starters" } | { action: "create", key, title, category, content } | { action: "save_version", templateId, baseVersion, content, note? }
 * | { action: "publish", templateId, version }. Saving needs doc_template.edit; publishing needs doc_template.publish and a different person from the author.
 */
async function handlePost(req: Request) {
  const staff = await staffGateAny(req, ["doc_template.edit", "doc_template.publish"]);
  if (staff instanceof NextResponse) return staff;
  const body = await readBoundedJson(req, MAX_BYTES);
  if (body instanceof NextResponse) return body;
  const db = getDb();
  const action = body["action"];
  const edit = staffCan(staff, "doc_template.edit"), publish = staffCan(staff, "doc_template.publish");

  if (action === "publish") {
    if (!publish) return fail(403, "Not allowed.");
    const version = body["version"];
    if (typeof body["templateId"] !== "string" || typeof version !== "number" || !Number.isInteger(version)) return fail(400, "Choose a template and version.");
    const out = await publishVersion(db, staff, body["templateId"], version);
    return out.ok ? NextResponse.json({ ok: true }, { headers: NO_STORE }) : fail(STATUS[out.code], out.error);
  }
  if (!edit) return fail(403, "Not allowed.");
  if (action === "install_starters") return NextResponse.json(await installStarters(db, staff), { headers: NO_STORE });

  if (action === "create" || action === "save_version") {
    const content = validateTemplateContent(body["content"]);
    if (!content.ok) return NextResponse.json({ error: "The template content is not valid.", problems: content.errors }, { status: 400, headers: NO_STORE });
    if (action === "create") {
      const out = await createTemplate(db, staff, { key: String(body["key"] ?? ""), title: String(body["title"] ?? ""), category: String(body["category"] ?? ""), content: content.value });
      return out.ok ? NextResponse.json({ id: out.id }, { status: 201, headers: NO_STORE }) : fail(STATUS[out.code], out.error);
    }
    const base = body["baseVersion"];
    if (typeof body["templateId"] !== "string" || typeof base !== "number" || !Number.isInteger(base)) return fail(400, "baseVersion must be the version you loaded.");
    const out = await saveVersion(db, staff, body["templateId"], base, content.value, typeof body["note"] === "string" ? body["note"] : "");
    return out.ok ? NextResponse.json({ version: out.version }, { headers: NO_STORE }) : fail(STATUS[out.code], out.error);
  }
  return fail(400, "Unknown action.");
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
