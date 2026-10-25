import { NextResponse } from "next/server";
import { parseNewVersion } from "../../../../src/domain/disclosure-config";
import { staffCan } from "../../../../src/domain/staff-access";
import { getDb } from "../../../../src/server/context";
import { createDraftVersionPg, listVersionsPg } from "../../../../src/server/disclosure-config-db";
import { fail, readJsonObject, staffAudit, staffGate } from "../../../../src/server/staff-route";
import { withApi } from "../../../../src/server/api/with-api";

/** Every requirements version (draft, approved, retired). For staff who draft or approve them. */
async function handleGet(req: Request) {
  const staff = await staffGate(req, "disclosure.config_edit").then(async s => (s instanceof NextResponse ? staffGate(req, "disclosure.config_approve") : s));
  if (staff instanceof NextResponse) return staff;
  return NextResponse.json({
    versions: await listVersionsPg(getDb()), me: staff.id,
    can: { edit: staffCan(staff, "disclosure.config_edit"), approve: staffCan(staff, "disclosure.config_approve") }
  }, { headers: { "cache-control": "no-store" } });
}

/** Drafts the next version of a combination: { jurisdiction, transactionType, useClass, items, note }. It does nothing until approved. */
async function handlePost(req: Request) {
  const staff = await staffGate(req, "disclosure.config_edit");
  if (staff instanceof NextResponse) return staff;
  const parsed = parseNewVersion(await readJsonObject(req));
  if (!parsed.ok) return fail(400, parsed.message);
  const r = await createDraftVersionPg(getDb(), parsed.value, staff.id);
  if (!r.ok) return fail(409, "Someone else drafted this combination at the same moment. Reload and try again.");
  const v = parsed.value;
  await staffAudit(staff, "disclosure_config", r.id, "staff.disclosure_config_drafted", {
    jurisdiction: v.jurisdiction, transactionType: v.transactionType, useClass: v.useClass, version: r.version, keys: v.items.map(i => i.key)
  });
  return NextResponse.json({ id: r.id, version: r.version }, { status: 201 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
